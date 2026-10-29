import { createHash } from "node:crypto"
import { basename } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { OpenCodeEvent } from "@opencode/client"
import {
  isRetryableError,
  request as sendRequest,
  wait,
  TimeoutError,
  type DeliveryPolicy,
} from "./transport.js"

type NtfyStorage = Pick<Plugin.Context["storage"], "get" | "set" | "remove" | "scan">
type NtfyPermission = {
  readonly hook?: Plugin.Context["permission"]["hook"]
  readonly list?: Plugin.Context["permission"]["list"]
  readonly get?: Plugin.Context["permission"]["get"]
}
type NtfyLocation = Pick<Plugin.Context["location"], "directory" | "workspaceID"> & {
  readonly project?: {
    readonly id?: string
  }
}
type NtfySession = {
  readonly get: Plugin.Context["session"]["get"]
  readonly list?: Plugin.Context["session"]["list"]
}
type NtfyHookSession = NtfySession & Pick<Plugin.Context["session"], "hook">

type NtfyContext = {
  readonly app?: {
    readonly version?: string
  }
  readonly options?: Plugin.Context["options"]
  readonly location?: NtfyLocation
  readonly session: NtfySession
  readonly permission?: NtfyPermission
  readonly storage?: NtfyStorage
}

type NtfySetupContext = NtfyContext & {
  readonly event: Pick<Plugin.Context["event"], "subscribe">
  readonly session: NtfyHookSession
}

type NotificationEvent = OpenCodeEvent

type EventWatermark = {
  aggregateID?: string
  seq?: number
  created?: number
}

type NtfyLocationIdentity = {
  readonly directory?: string
  readonly workspaceID?: string
  readonly projectID?: string
}

type OutboxKind = "completion" | "question" | "permission"

type OutboxRecord = {
  readonly v: 1
  readonly sequenceID: string
  readonly kind: OutboxKind
  readonly ownerID: string
  readonly sessionID: string
}

type SessionCheckpoint = {
  readonly v: 1
  readonly sessionID: string
  readonly active: true
  readonly since?: number
  readonly directory?: string
  readonly workspaceID?: string
  readonly projectID?: string
}

type RuntimeOptions = {
  readonly deferReconcile?: boolean
}

type RequestKind = "question" | "permission"
type RequestDelivery = "idle" | "publishing" | "delivered" | "failed"

type AlertToken = {
  readonly sequenceID: string
  readonly controller: AbortController
  cancelled: boolean
}

type SequenceState = {
  possibleActive: boolean
}

type RequestEntry = {
  readonly kind: RequestKind
  readonly id: string
  readonly sessionID: string
  readonly sequenceID: string
  delivery: RequestDelivery
  token?: AlertToken
  invalidation?: Promise<void>
}

type CompletionAttempt = {
  readonly generation: number
  readonly token: AlertToken
  promise: Promise<void>
}

type SessionState = {
  title?: string
  parentKnown: boolean
  parentID?: string
  projectID?: string
  workspaceID?: string
  location?: string
  archived: boolean
  generation: number
  incarnation: number
  revision: number
  running: boolean
  deliveredGeneration?: number
  baselineDeliveredGeneration?: number
  completion?: CompletionAttempt
  completionBlocked?: boolean
  eventSequences: Map<string, number>
  serverCreated?: number
  outcome?: "succeeded" | "failed" | "interrupted"
  idleAt?: number
  lastRetryAttempt?: number
  pendingPrompt?: boolean
}

type SessionTombstone = {
  readonly sequences: Map<string, number>
  readonly serverCreated?: number
}

const defaultPolicy: DeliveryPolicy = {
  requestTimeoutMs: 5000,
  retryAttempts: 3,
  retryDelayMs: 250,
}
const defaultPermissionDelayMs = 100
const maximumFailureLength = 320
const maximumStoredSessions = 512
const maximumPermissionReconciles = 24
const maximumReconcileLookups = 64
const maximumBufferedEvents = 10_000
const reconcileConcurrency = 4
const outboxSchemaVersion = 1

const relevantEventTypes = [
  "session.idle",
  "session.status",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.retry.scheduled",
  "session.created",
  "session.renamed",
  "session.moved",
  "session.deleted",
  "session.archived",
  "session.unarchived",
  "form.created",
  "form.replied",
  "form.cancelled",
  "permission.asked",
  "permission.replied",
] as const
const relevantEventTypeSet: ReadonlySet<string> = new Set(relevantEventTypes)
const notificationClearingEventTypes: ReadonlySet<string> = new Set([
  "session.created",
  "session.renamed",
  "session.moved",
  "session.deleted",
  "session.archived",
  "session.unarchived",
  "form.replied",
  "form.cancelled",
  "permission.replied",
])

const oneLine = (value: unknown, limit = 120) =>
  String(value).replace(/\s+/g, " ").trim().slice(0, limit)

const isAbortError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error as { name?: unknown }).name === "AbortError"

const abortError = () => new DOMException("Operation aborted", "AbortError")

const integerSetting = (
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
  allowString: boolean,
) => {
  if (value === undefined) return fallback
  const numeric =
    typeof value === "number"
      ? value
      : allowString && typeof value === "string" && /^[-+]?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(
      `opencode-ntfy ${field} must be an integer from ${minimum} to ${maximum}; received ${oneLine(value, 80)}`,
    )
  }
  return numeric
}

const readIntegerSetting = (
  options: Readonly<Record<string, unknown>> | undefined,
  environment: Readonly<Record<string, string | undefined>> | undefined,
  optionName: string,
  environmentName: string,
  minimum: number,
  maximum: number,
  fallback: number,
) => {
  const optionValue = options?.[optionName]
  if (optionValue !== undefined) {
    return integerSetting(
      optionValue,
      `option ${optionName}`,
      minimum,
      maximum,
      fallback,
      false,
    )
  }
  const environmentValue = environment?.[environmentName]
  if (environmentValue !== undefined) {
    return integerSetting(
      environmentValue,
      `environment variable ${environmentName}`,
      minimum,
      maximum,
      fallback,
      true,
    )
  }
  return fallback
}

const readBooleanSetting = (
  options: Readonly<Record<string, unknown>> | undefined,
  environment: Readonly<Record<string, string | undefined>> | undefined,
  optionName: string,
  environmentName: string,
  fallback: boolean,
) => {
  const optionValue = options?.[optionName]
  if (optionValue !== undefined) {
    if (typeof optionValue !== "boolean") {
      throw new Error(`opencode-ntfy option ${optionName} must be a boolean`)
    }
    return optionValue
  }
  const environmentValue = environment?.[environmentName]
  if (environmentValue !== undefined) {
    const normalized = environmentValue.trim().toLowerCase()
    if (["true", "1", "yes", "on"].includes(normalized)) return true
    if (["false", "0", "no", "off"].includes(normalized)) return false
    throw new Error(
      `opencode-ntfy environment variable ${environmentName} for ${optionName} must be true or false`,
    )
  }
  return fallback
}

const minimumHostVersion = "2.2.1"

const releaseVersion = (value: string | undefined) => {
  if (typeof value !== "string") return undefined
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(value)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const
}

const versionAtLeast = (actual: string | undefined, minimum: string) => {
  const current = releaseVersion(actual)
  const required = releaseVersion(minimum)
  if (!current || !required) return true
  for (let index = 0; index < 3; index++) {
    if (current[index] > required[index]) return true
    if (current[index] < required[index]) return false
  }
  return true
}

const assertSupportedHost = (ctx: NtfyContext) => {
  const version = ctx.app?.version
  if (!versionAtLeast(version, minimumHostVersion)) {
    throw new Error(
      `opencode-ntfy requires OpenCode ${minimumHostVersion} or newer; host version is ${oneLine(version, 40)}`,
    )
  }
}

const parseServerUrl = (value: string) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("opencode-ntfy server URL must be a valid absolute URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("opencode-ntfy server URL must use http or https")
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("opencode-ntfy server URL must not include username or password")
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("opencode-ntfy server URL must not include a query or fragment")
  }
  return { url, base: `${url.origin}${url.pathname}`.replace(/\/+$/, "") }
}

const normalizeSessionInfo = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Readonly<Record<string, unknown>>
  const data = record.data
  if (typeof data === "object" && data !== null) {
    return data as Readonly<Record<string, unknown>>
  }
  return record
}

const normalizeListData = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value
  if (typeof value !== "object" || value === null) return []
  const data = (value as Readonly<Record<string, unknown>>).data
  return Array.isArray(data) ? data : []
}

const eventWatermark = (event: NotificationEvent): EventWatermark => {
  const record = event as {
    created?: unknown
    durable?: {
      aggregateID?: unknown
      seq?: unknown
    }
  }
  const created = typeof record.created === "number" ? record.created : undefined
  const durable = record.durable
  if (typeof durable !== "object" || durable === null) return { created }
  return {
    created,
    aggregateID: typeof durable.aggregateID === "string" ? durable.aggregateID : undefined,
    seq: typeof durable.seq === "number" ? durable.seq : undefined,
  }
}

const sessionIDFromEvent = (event: NotificationEvent) => {
  const data = event.data as Readonly<Record<string, unknown>> | undefined
  if (typeof data?.sessionID === "string") return data.sessionID
  const form = data?.form
  if (typeof form === "object" && form !== null) {
    const sessionID = (form as Readonly<Record<string, unknown>>).sessionID
    if (typeof sessionID === "string") return sessionID
  }
  return undefined
}

export async function createNtfyRuntime(ctx: NtfyContext, runtimeOptions: RuntimeOptions = {}) {
  const options = ctx.options
  const environment = (
    globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }
  ).process?.env
  const pluginOption = (name: string) =>
    typeof options?.[name] === "string" ? (options[name] as string) : undefined
  const environmentVariable = (name: string) => environment?.[name]
  const optionOrEnvironment = (optionName: string, environmentName: string) =>
    pluginOption(optionName) ?? environmentVariable(environmentName)
  const hideChatContentEnvironment = environmentVariable("NTFY_HIDE_CHAT_CONTENT")
  const hideChatContent =
    (typeof options?.hideChatContent === "boolean" ? options.hideChatContent : undefined) ??
    (hideChatContentEnvironment === undefined ||
      !["0", "false", "no", "off"].includes(hideChatContentEnvironment.trim().toLowerCase()))

  const topic = optionOrEnvironment("topic", "NTFY_TOPIC")
  if (!topic) throw new Error("opencode-ntfy requires NTFY_TOPIC or a topic plugin option")

  const policy: DeliveryPolicy = {
    requestTimeoutMs: readIntegerSetting(
      options,
      environment,
      "requestTimeoutMs",
      "NTFY_REQUEST_TIMEOUT_MS",
      1,
      120_000,
      defaultPolicy.requestTimeoutMs,
    ),
    retryAttempts: readIntegerSetting(
      options,
      environment,
      "retryAttempts",
      "NTFY_RETRY_ATTEMPTS",
      1,
      5,
      defaultPolicy.retryAttempts,
    ),
    retryDelayMs: readIntegerSetting(
      options,
      environment,
      "retryDelayMs",
      "NTFY_RETRY_DELAY_MS",
      0,
      30_000,
      defaultPolicy.retryDelayMs,
    ),
  }
  const shutdownPolicy: DeliveryPolicy = { ...policy, retryAttempts: 1 }
  const permissionDelayMs = readIntegerSetting(
    options,
    environment,
    "permissionDelayMs",
    "NTFY_PERMISSION_DELAY_MS",
    0,
    60_000,
    defaultPermissionDelayMs,
  )
  const priority = readIntegerSetting(
    options,
    environment,
    "priority",
    "NTFY_PRIORITY",
    1,
    5,
    4,
  )
  const allowInsecureHttp = readBooleanSetting(
    options,
    environment,
    "allowInsecureHttp",
    "NTFY_ALLOW_INSECURE_HTTP",
    false,
  )
  const showProjectDirectory = readBooleanSetting(
    options,
    environment,
    "showProjectDirectory",
    "NTFY_SHOW_PROJECT_DIRECTORY",
    false,
  )

  const server = parseServerUrl(
    pluginOption("server") ??
      pluginOption("url") ??
      environmentVariable("NTFY_SERVER") ??
      environmentVariable("NTFY_URL") ??
      "https://ntfy.sh",
  )
  const baseUrl = server.base
  const optionToken = pluginOption("token")
  const optionUsername = pluginOption("username")
  const optionPassword = pluginOption("password")
  const hasPrimaryAuthOptions =
    optionToken !== undefined || optionUsername !== undefined || optionPassword !== undefined
  const token = hasPrimaryAuthOptions ? optionToken : environmentVariable("NTFY_TOKEN")
  const username = hasPrimaryAuthOptions
    ? optionUsername
    : environmentVariable("NTFY_USERNAME")
  const password = hasPrimaryAuthOptions
    ? optionPassword
    : environmentVariable("NTFY_PASSWORD")
  if ((username === undefined) !== (password === undefined)) {
    throw new Error("opencode-ntfy requires both username and password for Basic authentication")
  }
  if (token && username !== undefined) {
    throw new Error("opencode-ntfy accepts either a token or username/password, not both")
  }
  const basicCredentials =
    username !== undefined && password !== undefined
      ? btoa(String.fromCharCode(...new TextEncoder().encode(`${username}:${password}`)))
      : undefined
  const authorization = token
    ? `Bearer ${token}`
    : basicCredentials
      ? `Basic ${basicCredentials}`
      : undefined
  const authHeaders: Record<string, string> = authorization
    ? { Authorization: authorization }
    : {}
  if (authorization !== undefined && server.url.protocol === "http:" && !allowInsecureHttp) {
    throw new Error(
      "opencode-ntfy refuses to send credentials over http; set allowInsecureHttp or NTFY_ALLOW_INSECURE_HTTP to allow it",
    )
  }

  const locationDirectory =
    typeof ctx.location?.directory === "string" ? ctx.location.directory : undefined
  const locationWorkspaceID =
    typeof ctx.location?.workspaceID === "string" ? ctx.location.workspaceID : undefined
  const locationProjectID =
    typeof ctx.location?.project?.id === "string" ? ctx.location.project.id : undefined
  const locationIdentity =
    locationWorkspaceID !== undefined
      ? `workspace:${locationWorkspaceID}`
      : `project:${locationProjectID ?? ""}|directory:${locationDirectory ?? ""}`
  const storageNamespace = createHash("sha256")
    .update(JSON.stringify({ server: baseUrl, topic, location: locationIdentity }))
    .digest("hex")
  const outboxPrefix = `opencode-ntfy:v1:${storageNamespace}:sequence:`
  const checkpointPrefix = `opencode-ntfy:v1:${storageNamespace}:session:`

  const requests = new Map<string, RequestEntry>()
  const permissions = new Map<string, RequestEntry>()
  const requestIDsBySession = new Map<string, Set<string>>()
  const permissionIDsBySession = new Map<string, Set<string>>()
  const sessionStates = new Map<string, SessionState>()
  const sessionTombstones = new Map<string, SessionTombstone>()
  const inactiveSessions = new Set<string>()
  const sequenceStates = new Map<string, SequenceState>()
  const sequenceChains = new Map<string, Promise<void>>()
  const checkpointChains = new Map<string, Promise<void>>()
  const permissionReconciles = new Map<string, Promise<void>>()
  const permissionAdvisories = new Map<string, AbortController>()
  const activeTokens = new Set<AlertToken>()
  const liveControllers = new Set<AbortController>()
  const detachedTasks = new Set<Promise<void>>()
  const persistedSequences = new Set<string>()
  const storedCheckpoints = new Map<string, SessionCheckpoint>()
  const restoredOutbox = new Map<string, OutboxRecord>()
  const answeredPermissions = new Map<string, number>()
  const bufferedEvents: NotificationEvent[] = []
  const dirtySessionEpoch = new Map<string, number>()

  const notificationMessage = (sessionID: string, message: string) => {
    if (!showProjectDirectory) return message
    const directory = sessionStates.get(sessionID)?.location ?? locationDirectory
    if (directory === undefined) return message
    const name = basename(directory)
    if (name.trim() === "" || name === "/" || name === "." || name === "..") return message
    return `${message}\n${name}`
  }

  let disposed = false
  let disposePromise: Promise<void> | undefined
  let lastFailure: string | undefined
  let suppressedFailures = 0
  let sessionRevision = 0
  let eventEpoch = 0
  let bufferOverflowReported = false
  let started = false
  let reconciling = false
  let reconcilePromise: Promise<void> | undefined
  let reconcileRequested = false
  let initialSnapshotComplete = false

  const failureHint = (status?: number) => {
    if (status === 401 || status === 403) {
      return "Hint: set NTFY_TOKEN or username/password; check topic permissions."
    }
    if (status === 429) return "Hint: ntfy rate limit reached; retry later."
    if (status === undefined) return "Hint: ntfy server unreachable; check network and server URL."
    return ""
  }

  const logFailure = (message: string) => {
    const normalized = oneLine(message, maximumFailureLength)
    if (normalized === lastFailure) {
      suppressedFailures++
      return
    }
    const suffix =
      suppressedFailures > 0 ? ` (${suppressedFailures} identical failure(s) suppressed)` : ""
    console.error(`[opencode-ntfy] ${normalized}${suffix}`)
    lastFailure = normalized
    suppressedFailures = 0
  }

  const recordSuccess = (action: string) => {
    if (suppressedFailures > 0) {
      console.error(
        `[opencode-ntfy] ${action} recovered (${suppressedFailures} identical failure(s) suppressed)`,
      )
    }
    lastFailure = undefined
    suppressedFailures = 0
  }

  const formatError = (action: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof Error && message.startsWith("ntfy ")) {
      return oneLine(message, maximumFailureLength)
    }
    const networkFailure =
      error instanceof TypeError || (error instanceof Error && /fetch failed|network/i.test(message))
    return `${action} failed: ${oneLine(message)}${networkFailure ? ` ${failureHint()}` : ""}`
  }

  const topicUrl = (name: string, suffix = "") => `${baseUrl}/${encodeURIComponent(name)}${suffix}`

  const completionSequenceID = (sessionID: string) => `opencode-${sessionID}`
  const questionSequenceID = (requestID: string) => `opencode-question-${requestID}`
  const permissionSequenceID = (requestID: string) => `opencode-permission-${requestID}`
  const outboxKey = (sequenceID: string) => `${outboxPrefix}${encodeURIComponent(sequenceID)}`
  const checkpointKey = (sessionID: string) => `${checkpointPrefix}${encodeURIComponent(sessionID)}`

  const runBoundedRequest = async <T>(
    action: string,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController()
    liveControllers.add(controller)
    if (signal?.aborted) {
      liveControllers.delete(controller)
      throw abortError()
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let onAbort = () => {}
    let onControllerAbort = () => {}
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      signal?.removeEventListener("abort", onAbort)
      controller.signal.removeEventListener("abort", onControllerAbort)
      liveControllers.delete(controller)
    }

    const stop = new Promise<never>((_, reject) => {
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      onAbort = () => {
        controller.abort()
        fail(abortError())
      }
      onControllerAbort = () => fail(abortError())
      controller.signal.addEventListener("abort", onControllerAbort, { once: true })
      signal?.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(() => {
        fail(new TimeoutError(action, policy.requestTimeoutMs))
        controller.abort()
      }, policy.requestTimeoutMs)
    })

    try {
      const request = Promise.resolve(operation(controller.signal))
      void request.catch(() => {})
      return await Promise.race([request, stop])
    } finally {
      settled = true
      cleanup()
      controller.abort()
    }
  }

  const markDirtySession = (sessionID: string, epoch: number) => {
    const current = dirtySessionEpoch.get(sessionID)
    if (current === undefined || epoch > current) dirtySessionEpoch.set(sessionID, epoch)
  }

  const markBufferedEvent = (event: NotificationEvent) => {
    const epoch = ++eventEpoch
    let sessionID = sessionIDFromEvent(event)
    if (sessionID === undefined && event.type === "form.replied") {
      sessionID = requests.get(event.data.id)?.sessionID
    } else if (sessionID === undefined && event.type === "form.cancelled") {
      sessionID = requests.get(event.data.id)?.sessionID
    } else if (sessionID === undefined && event.type === "permission.replied") {
      sessionID = permissions.get(event.data.requestID)?.sessionID
    }
    if (sessionID !== undefined) markDirtySession(sessionID, epoch)
    return epoch
  }

  const isDirtySince = (sessionID: string, epoch: number) =>
    (dirtySessionEpoch.get(sessionID) ?? 0) > epoch

  const touchSession = (state: SessionState) => {
    sessionRevision++
    state.revision = sessionRevision
  }

  const trackDetached = (task: Promise<void>) => {
    detachedTasks.add(task)
    void task.then(
      () => detachedTasks.delete(task),
      () => detachedTasks.delete(task),
    )
  }

  const sequenceKind = (sequenceID: string): OutboxKind | undefined => {
    if (sequenceID.startsWith("opencode-question-")) return "question"
    if (sequenceID.startsWith("opencode-permission-")) return "permission"
    if (sequenceID.startsWith("opencode-") && sequenceID.length > "opencode-".length) {
      return "completion"
    }
    return undefined
  }

  const validIdentifier = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 512

  const normalizeOutboxRecord = (
    key: string,
    value: unknown,
  ): OutboxRecord | undefined => {
    if (typeof value !== "object" || value === null) return undefined
    const record = value as Readonly<Record<string, unknown>>
    if (record.v !== outboxSchemaVersion) return undefined
    if (record.kind !== "completion" && record.kind !== "question" && record.kind !== "permission") {
      return undefined
    }
    if (
      !validIdentifier(record.sequenceID) ||
      !validIdentifier(record.ownerID) ||
      !validIdentifier(record.sessionID)
    ) {
      return undefined
    }
    if (outboxKey(record.sequenceID) !== key) return undefined
    if (sequenceKind(record.sequenceID) !== record.kind) return undefined
    return {
      v: 1,
      sequenceID: record.sequenceID,
      kind: record.kind,
      ownerID: record.ownerID,
      sessionID: record.sessionID,
    }
  }

  const normalizeCheckpoint = (
    key: string,
    value: unknown,
  ): SessionCheckpoint | undefined => {
    if (typeof value !== "object" || value === null) return undefined
    const record = value as Readonly<Record<string, unknown>>
    if (record.v !== outboxSchemaVersion || record.active !== true) return undefined
    if (!validIdentifier(record.sessionID)) return undefined
    if (checkpointKey(record.sessionID) !== key) return undefined
    const since = typeof record.since === "number" && Number.isFinite(record.since)
      ? record.since
      : undefined
    const directory = typeof record.directory === "string" ? record.directory : undefined
    const workspaceID =
      typeof record.workspaceID === "string" ? record.workspaceID : undefined
    const projectID = typeof record.projectID === "string" ? record.projectID : undefined
    return {
      v: 1,
      sessionID: record.sessionID,
      active: true,
      ...(since === undefined ? {} : { since }),
      ...(directory === undefined ? {} : { directory }),
      ...(workspaceID === undefined ? {} : { workspaceID }),
      ...(projectID === undefined ? {} : { projectID }),
    }
  }

  const scanStorage = async (prefix: string) => {
    const storage = ctx.storage
    if (!storage || typeof storage.scan !== "function") return []
    const entries: Array<{ key: string; value: unknown }> = []
    let after: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await runBoundedRequest(
        "ntfy durable state scan",
        undefined,
        () =>
          storage.scan({
            prefix,
            limit: 100,
            ...(after === undefined ? {} : { after }),
          }),
      )
      entries.push(...result.entries)
      const next = result.next
      if (typeof next !== "string" || next.length === 0 || next === after) break
      after = next
    }
    return entries
  }

  const loadDurableState = async () => {
    if (!ctx.storage) return
    try {
      const [sequenceEntries, checkpointEntries] = await Promise.all([
        scanStorage(outboxPrefix),
        scanStorage(checkpointPrefix),
      ])
      for (const entry of sequenceEntries) {
        const record = normalizeOutboxRecord(entry.key, entry.value)
        if (!record) continue
        const state = ensureSequenceState(record.sequenceID)
        state.possibleActive = true
        persistedSequences.add(record.sequenceID)
        restoredOutbox.set(record.sequenceID, record)
      }
      for (const entry of checkpointEntries) {
        const checkpoint = normalizeCheckpoint(entry.key, entry.value)
        if (checkpoint) storedCheckpoints.set(checkpoint.sessionID, checkpoint)
      }
    } catch (error) {
      if (!disposed) logFailure(formatError("ntfy durable state load", error))
    }
  }

  const persistSequence = async (record: OutboxRecord) => {
    persistedSequences.add(record.sequenceID)
    if (!ctx.storage) {
      restoredOutbox.delete(record.sequenceID)
      return
    }
    try {
      await ctx.storage.set(outboxKey(record.sequenceID), record)
      restoredOutbox.delete(record.sequenceID)
    } catch (error) {
      if (!disposed) logFailure(formatError("ntfy durable state write", error))
      // An untracked publish cannot be safely cleared after a restart.
      throw error
    }
  }

  const removePersistedSequence = async (sequenceID: string) => {
    if (!persistedSequences.has(sequenceID)) {
      restoredOutbox.delete(sequenceID)
      return
    }
    if (!ctx.storage) {
      persistedSequences.delete(sequenceID)
      restoredOutbox.delete(sequenceID)
      return
    }
    try {
      await ctx.storage.remove(outboxKey(sequenceID))
      persistedSequences.delete(sequenceID)
      restoredOutbox.delete(sequenceID)
    } catch (error) {
      if (!disposed) logFailure(formatError("ntfy durable state remove", error))
    }
  }

  const enqueueCheckpoint = (sessionID: string, task: () => Promise<void>) => {
    const previous = checkpointChains.get(sessionID) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    checkpointChains.set(sessionID, tail)
    void tail.then(() => {
      if (checkpointChains.get(sessionID) === tail) checkpointChains.delete(sessionID)
    })
    return run
  }

  const persistCheckpoint = (sessionID: string, state: SessionState, since?: number) => {
    if (!ctx.storage || inactiveSessions.has(sessionID) || state.archived) return
    const previous = storedCheckpoints.get(sessionID)
    const checkpoint: SessionCheckpoint = {
      v: 1,
      sessionID,
      active: true,
      ...(since === undefined
        ? previous?.since === undefined
          ? {}
          : { since: previous.since }
        : { since }),
      ...(state.location === undefined
        ? previous?.directory === undefined
          ? {}
          : { directory: previous.directory }
        : { directory: state.location }),
      ...(state.workspaceID === undefined
        ? previous?.workspaceID === undefined
          ? {}
          : { workspaceID: previous.workspaceID }
        : { workspaceID: state.workspaceID }),
      ...(state.projectID === undefined
        ? previous?.projectID === undefined
          ? {}
          : { projectID: previous.projectID }
        : { projectID: state.projectID }),
    }
    storedCheckpoints.set(sessionID, checkpoint)
    void enqueueCheckpoint(sessionID, async () => {
      try {
        await ctx.storage!.set(checkpointKey(sessionID), checkpoint)
      } catch (error) {
        if (!disposed) logFailure(formatError("ntfy session checkpoint write", error))
      }
    })
  }

  const removeCheckpoint = (sessionID: string) => {
    if (!storedCheckpoints.delete(sessionID)) return
    if (!ctx.storage) return
    void enqueueCheckpoint(sessionID, async () => {
      try {
        await ctx.storage!.remove(checkpointKey(sessionID))
      } catch (error) {
        if (!disposed) logFailure(formatError("ntfy session checkpoint remove", error))
      }
    })
  }

  const mapWithConcurrency = async <T>(
    items: readonly T[],
    limit: number,
    task: (item: T) => Promise<void>,
  ) => {
    let index = 0
    const workers = Array.from(
      { length: Math.min(Math.max(1, limit), Math.max(1, items.length)) },
      async () => {
        for (;;) {
          const current = index++
          if (current >= items.length) return
          await task(items[current])
        }
      },
    )
    await Promise.all(workers)
  }

  const ensureSessionState = (sessionID: string) => {
    let state = sessionStates.get(sessionID)
    if (!state) {
      const tombstone = sessionTombstones.get(sessionID)
      state = {
        parentKnown: false,
        archived: false,
        generation: 0,
        incarnation: 0,
        revision: 0,
        running: false,
        eventSequences: new Map(tombstone?.sequences),
        ...(tombstone?.serverCreated === undefined
          ? {}
          : { serverCreated: tombstone.serverCreated }),
      }
      sessionStates.set(sessionID, state)
    }
    return state
  }

  const ensureSequenceState = (sequenceID: string) => {
    let state = sequenceStates.get(sequenceID)
    if (!state) {
      state = { possibleActive: false }
      sequenceStates.set(sequenceID, state)
    }
    return state
  }

  const newToken = (sequenceID: string) => {
    const token: AlertToken = {
      sequenceID,
      controller: new AbortController(),
      cancelled: false,
    }
    activeTokens.add(token)
    return token
  }

  const finishToken = (token: AlertToken) => {
    activeTokens.delete(token)
  }

  const cancelToken = (token: AlertToken) => {
    if (token.cancelled) return
    token.cancelled = true
    token.controller.abort()
  }

  const enqueue = <T>(sequenceID: string, task: () => Promise<T>): Promise<T> => {
    const previous = sequenceChains.get(sequenceID) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    sequenceChains.set(sequenceID, tail)
    void tail.then(() => {
      if (sequenceChains.get(sequenceID) === tail) sequenceChains.delete(sequenceID)
    })
    return run
  }

  const publishSequence = (
    token: AlertToken,
    message: Record<string, unknown>,
    isValid: () => boolean,
    owner: { readonly kind: OutboxKind; readonly ownerID: string; readonly sessionID: string },
  ) =>
    enqueue(token.sequenceID, async () => {
      if (disposed || token.cancelled || !isValid()) throw abortError()
      const state = ensureSequenceState(token.sequenceID)
      const priorPossibleActive = state.possibleActive
      const priorPersisted = persistedSequences.has(token.sequenceID)
      // A prior attempt on this sequence may already have reached ntfy. A later
      // failed write or cancellation must not erase that knowledge.
      const hadPriorKnowledge = priorPossibleActive || priorPersisted
      // From this point on the POST may reach ntfy even if it is interrupted.
      state.possibleActive = true
      try {
        await persistSequence({
          v: 1,
          sequenceID: token.sequenceID,
          kind: owner.kind,
          ownerID: owner.ownerID,
          sessionID: owner.sessionID,
        })
      } catch (error) {
        state.possibleActive = hadPriorKnowledge
        if (priorPersisted) persistedSequences.add(token.sequenceID)
        else persistedSequences.delete(token.sequenceID)
        throw error
      }
      if (disposed || token.cancelled || !isValid()) {
        if (hadPriorKnowledge) {
          state.possibleActive = true
          persistedSequences.add(token.sequenceID)
        } else {
          state.possibleActive = false
          await removePersistedSequence(token.sequenceID)
        }
        throw abortError()
      }
      await sendRequest(
        `${baseUrl}/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ topic, ...message, sequence_id: token.sequenceID }),
          redirect: "error",
        },
        "ntfy publish",
        policy,
        token.controller.signal,
      )
      recordSuccess("ntfy publish")
    })

  const clearSequence = (
    sequenceID: string,
    clearOptions: { force?: boolean; shutdown?: boolean } = {},
  ) => {
    const force = clearOptions.force ?? false
    const shutdown = clearOptions.shutdown ?? false
    return enqueue(sequenceID, async () => {
      if (disposed && !shutdown) return
      const state = sequenceStates.get(sequenceID)
      if (!force && !state?.possibleActive) return
      const controller = new AbortController()
      if (!shutdown) liveControllers.add(controller)
      try {
        await sendRequest(
          topicUrl(topic, `/${encodeURIComponent(sequenceID)}/clear`),
          { method: "PUT", headers: authHeaders, redirect: "error" },
          "ntfy notification clear",
          shutdown ? shutdownPolicy : policy,
          controller.signal,
        )
        if (state) state.possibleActive = false
        await removePersistedSequence(sequenceID)
      } catch (error) {
        if (!isAbortError(error)) {
          logFailure(formatError("ntfy notification dismissal", error))
        }
      } finally {
        liveControllers.delete(controller)
        if (!state?.possibleActive && sequenceStates.get(sequenceID) === state) {
          sequenceStates.delete(sequenceID)
        }
      }
    })
  }

  const dismissCompletion = (sessionID: string, force = false) =>
    clearSequence(completionSequenceID(sessionID), { force })

  const getSessionBoundedOnce = async (
    sessionID: string,
    signal: AbortSignal,
    action: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined> => {
    const controller = new AbortController()
    liveControllers.add(controller)
    if (signal.aborted) {
      controller.abort()
      liveControllers.delete(controller)
      throw abortError()
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let onAbort = () => {}
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      signal.removeEventListener("abort", onAbort)
      liveControllers.delete(controller)
    }

    const stop = new Promise<never>((_, reject) => {
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      onAbort = () => {
        controller.abort()
        fail(abortError())
      }
      signal.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(() => {
        controller.abort()
        fail(new TimeoutError(action, policy.requestTimeoutMs))
      }, policy.requestTimeoutMs)
    })

    try {
      const lookup = Promise.resolve(ctx.session.get({ sessionID }, { signal: controller.signal }))
      void lookup.catch(() => {})
      const response = await Promise.race([lookup, stop])
      return normalizeSessionInfo(response)
    } finally {
      settled = true
      cleanup()
      controller.abort()
    }
  }

  const sessionLookupAttempts = Math.min(2, Math.max(1, Math.floor(policy.retryAttempts)))
  const getSessionBounded = async (
    sessionID: string,
    signal: AbortSignal,
    action: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined> => {
    let lastError: unknown
    for (let attemptIndex = 0; attemptIndex < sessionLookupAttempts; attemptIndex++) {
      if (signal.aborted) throw abortError()
      try {
        return await getSessionBoundedOnce(sessionID, signal, action)
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error
        lastError = error
        if (
          attemptIndex + 1 >= sessionLookupAttempts ||
          !isRetryableError(error)
        ) {
          throw error
        }
        await wait(policy.retryDelayMs, signal)
      }
    }
    throw lastError
  }

  const setSessionDirectory = (
    state: SessionState,
    directory: string,
    workspaceID: string | undefined,
  ) => {
    if (state.location !== undefined && state.location !== directory) {
      // A real directory move invalidates an identity that is no longer known to match.
      state.workspaceID = workspaceID
    } else if (workspaceID !== undefined) {
      state.workspaceID = workspaceID
    }
    state.location = directory
  }

  const mergeSessionInfo = (
    sessionID: string,
    info: Readonly<Record<string, unknown>> | undefined,
    snapshotRevision?: number,
  ) => {
    const state = ensureSessionState(sessionID)
    if (!info) return state
    // A snapshot or lookup that started before a newer event must not overwrite
    // fields that the newer event already established. Missing identity fields
    // are still filled in so concurrent harmless events cannot block lookups.
    const stale = snapshotRevision !== undefined && state.revision > snapshotRevision
    if (!stale || !state.parentKnown) {
      state.parentKnown = true
      state.parentID = typeof info.parentID === "string" ? info.parentID : undefined
    }
    if (typeof info.title === "string" && (!stale || state.title === undefined)) {
      state.title = info.title
    }
    if (typeof info.projectID === "string" && state.projectID === undefined) {
      state.projectID = info.projectID
    }
    if (typeof info.workspaceID === "string" && state.workspaceID === undefined) {
      state.workspaceID = info.workspaceID
    }
    if (!stale) {
      const location = info.location
      if (typeof location === "object" && location !== null) {
        const record = location as Readonly<Record<string, unknown>>
        const directory = record.directory
        const workspaceID =
          typeof record.workspaceID === "string" ? record.workspaceID : undefined
        if (typeof directory === "string") setSessionDirectory(state, directory, workspaceID)
        else if (workspaceID !== undefined) state.workspaceID = workspaceID
      }
      const time = info.time
      if (typeof time === "object" && time !== null) {
        const timeRecord = time as Readonly<Record<string, unknown>>
        const archived = timeRecord.archived
        state.archived = typeof archived === "number" && archived > 0
        const idle = timeRecord.idle
        if (typeof idle === "number" && Number.isFinite(idle)) state.idleAt = idle
      }
      if (
        info.outcome === "succeeded" ||
        info.outcome === "failed" ||
        info.outcome === "interrupted"
      ) {
        state.outcome = info.outcome
      }
    }
    return state
  }

  const stateIdentity = (state: SessionState | undefined): NtfyLocationIdentity => ({
    directory: state?.location,
    workspaceID: state?.workspaceID,
    projectID: state?.projectID,
  })

  const eventIdentity = (
    event: NotificationEvent,
    state: SessionState | undefined,
  ): NtfyLocationIdentity => {
    const data = event.data as Readonly<Record<string, unknown>> | undefined
    const dataLocation =
      typeof data?.location === "object" && data.location !== null
        ? (data.location as Readonly<Record<string, unknown>>)
        : undefined
    const envelope =
      typeof event.location === "object" && event.location !== null
        ? (event.location as Readonly<Record<string, unknown>>)
        : undefined
    const explicitDirectory =
      typeof envelope?.directory === "string"
        ? envelope.directory
        : typeof dataLocation?.directory === "string"
          ? (dataLocation.directory as string)
          : undefined
    const explicitWorkspaceID =
      typeof envelope?.workspaceID === "string"
        ? envelope.workspaceID
        : typeof dataLocation?.workspaceID === "string"
          ? (dataLocation.workspaceID as string)
          : undefined
    const directoryChanged =
      explicitDirectory !== undefined &&
      state?.location !== undefined &&
      explicitDirectory !== state.location
    return {
      directory: explicitDirectory ?? state?.location,
      workspaceID:
        explicitWorkspaceID !== undefined
          ? explicitWorkspaceID
          : directoryChanged
            ? undefined
            : state?.workspaceID,
      projectID:
        typeof data?.projectID === "string" ? data.projectID : state?.projectID,
    }
  }

  const rememberEventIdentity = (
    sessionID: string,
    identity: NtfyLocationIdentity,
  ) => {
    const state = sessionStates.get(sessionID)
    if (!state) return
    if (state.location === undefined && identity.directory !== undefined) {
      state.location = identity.directory
    }
    if (
      identity.workspaceID !== undefined &&
      (state.workspaceID === undefined ||
        state.location === undefined ||
        state.location === identity.directory)
    ) {
      state.workspaceID = identity.workspaceID
    }
    if (identity.projectID !== undefined && state.projectID === undefined) {
      state.projectID = identity.projectID
    }
  }

  const isOutsideWorkspace = (candidate: NtfyLocationIdentity | undefined) => {
    if (!candidate) return false
    if (locationWorkspaceID !== undefined && candidate.workspaceID !== undefined) {
      return candidate.workspaceID !== locationWorkspaceID
    }
    if (
      locationProjectID !== undefined &&
      candidate.projectID !== undefined &&
      candidate.projectID !== locationProjectID
    ) {
      return true
    }
    // A shared project is not enough to collapse separate worktrees.
    return (
      locationDirectory !== undefined &&
      candidate.directory !== undefined &&
      candidate.directory !== locationDirectory
    )
  }

  const isOutsideSession = (sessionID: string) =>
    isOutsideWorkspace(stateIdentity(sessionStates.get(sessionID)))

  const resolveRequestTitle = async (
    sessionID: string,
    signal: AbortSignal,
    action: string,
  ) => {
    if (hideChatContent || sessionID === "global") return "OpenCode"
    const state = ensureSessionState(sessionID)
    if (state.title !== undefined) return state.title
    const revision = state.revision
    try {
      const info = await getSessionBounded(sessionID, signal, action)
      mergeSessionInfo(sessionID, info, revision)
    } catch (error) {
      if (!isAbortError(error) && !disposed) {
        logFailure(formatError(action, error))
      }
    }
    return state.title ?? "OpenCode"
  }

  const resolveCompletionMetadata = async (sessionID: string, signal: AbortSignal) => {
    const state = ensureSessionState(sessionID)
    if (!state.parentKnown || (!hideChatContent && state.title === undefined)) {
      const revision = state.revision
      try {
        const info = await getSessionBounded(sessionID, signal, "ntfy completion notification")
        mergeSessionInfo(sessionID, info, revision)
      } catch (error) {
        if (!isAbortError(error) && !disposed) {
          logFailure(formatError("ntfy completion notification", error))
        }
      }
    }
    if (state.outcome === "failed" || state.outcome === "interrupted") {
      state.completionBlocked = true
      return undefined
    }
    if (isOutsideSession(sessionID)) return undefined
    // An unknown parent is not safe to treat as a root session.
    if (!state.parentKnown || state.parentID !== undefined) return undefined
    if (state.archived) return undefined
    return { title: hideChatContent ? "OpenCode" : state.title ?? "OpenCode" }
  }

  const isBlocked = (sessionID: string) =>
    (requestIDsBySession.get(sessionID)?.size ?? 0) > 0 ||
    (permissionIDsBySession.get(sessionID)?.size ?? 0) > 0

  const hasQuestions = (sessionID: string) =>
    (requestIDsBySession.get(sessionID)?.size ?? 0) > 0

  const hasPermissions = (sessionID: string) =>
    (permissionIDsBySession.get(sessionID)?.size ?? 0) > 0

  const addRequestIndex = (entries: Map<string, RequestEntry>, index: Map<string, Set<string>>, entry: RequestEntry) => {
    entries.set(entry.id, entry)
    let ids = index.get(entry.sessionID)
    if (!ids) {
      ids = new Set()
      index.set(entry.sessionID, ids)
    }
    ids.add(entry.id)
  }

  const removeRequestIndex = (
    entries: Map<string, RequestEntry>,
    index: Map<string, Set<string>>,
    entry: RequestEntry,
  ) => {
    if (entries.get(entry.id) === entry) entries.delete(entry.id)
    const ids = index.get(entry.sessionID)
    if (!ids) return
    ids.delete(entry.id)
    if (ids.size === 0) index.delete(entry.sessionID)
  }

  const cancelCompletionAttempt = (state: SessionState) => {
    const attempt = state.completion
    if (!attempt) return
    cancelToken(attempt.token)
    state.completion = undefined
  }

  const invalidateForActivity = (
    sessionID: string,
    force: boolean,
    activityAt?: number,
    activityOptions: { readonly prompt?: boolean } = {},
  ) => {
    const state = ensureSessionState(sessionID)
    // Repeated busy/status events during the same execution are harmless, but a
    // prompt awaiting native admission still needs its checkpoint cleared.
    if (
      !force &&
      !activityOptions.prompt &&
      !state.pendingPrompt &&
      state.running &&
      state.completion === undefined
    ) {
      return Promise.resolve()
    }
    state.running = true
    state.generation++
    state.deliveredGeneration = undefined
    state.completionBlocked = false
    state.outcome = undefined
    state.idleAt = undefined
    cancelCompletionAttempt(state)
    if (activityOptions.prompt) {
      // A prompt hook runs before admission. Do not make a recoverable active
      // checkpoint from local intent alone, and invalidate the previous cycle.
      state.pendingPrompt = true
      removeCheckpoint(sessionID)
    } else {
      state.pendingPrompt = false
      persistCheckpoint(sessionID, state, activityAt)
    }
    return dismissCompletion(sessionID)
  }

  const invalidateForRequest = (sessionID: string) => {
    const state = ensureSessionState(sessionID)
    state.running = true
    state.generation++
    state.deliveredGeneration = undefined
    cancelCompletionAttempt(state)
    return dismissCompletion(sessionID)
  }

  const noteRetryActivity = (
    sessionID: string,
    attempt: number | undefined,
    activityAt?: number,
  ) => {
    const state = ensureSessionState(sessionID)
    if (attempt !== undefined && state.lastRetryAttempt === attempt) {
      return Promise.resolve()
    }
    state.lastRetryAttempt = attempt
    state.completionBlocked = false
    state.outcome = undefined
    state.idleAt = undefined
    return invalidateForActivity(sessionID, true, activityAt)
  }

  const notifyFinished = (sessionID: string) => {
    if (disposed || inactiveSessions.has(sessionID) || hasQuestions(sessionID)) {
      return Promise.resolve()
    }
    const state = ensureSessionState(sessionID)
    if (
      state.archived ||
      state.completionBlocked ||
      state.outcome === "failed" ||
      state.outcome === "interrupted" ||
      isOutsideSession(sessionID)
    ) {
      if (state.outcome === "failed" || state.outcome === "interrupted") {
        state.completionBlocked = true
      }
      removeCheckpoint(sessionID)
      return Promise.resolve()
    }
    state.running = false
    state.lastRetryAttempt = undefined
    if (state.deliveredGeneration === state.generation) {
      removeCheckpoint(sessionID)
      return Promise.resolve()
    }
    if (state.completion?.generation === state.generation) {
      return state.completion.promise
    }

    const generation = state.generation
    const token = newToken(completionSequenceID(sessionID))
    const attempt = {
      generation,
      token,
      promise: Promise.resolve(),
    } as CompletionAttempt
    state.completion = attempt

    const isValid = () =>
      !disposed &&
      !token.cancelled &&
      !inactiveSessions.has(sessionID) &&
      !state.archived &&
      !state.completionBlocked &&
      state.outcome !== "failed" &&
      state.outcome !== "interrupted" &&
      !isOutsideSession(sessionID) &&
      state.generation === generation &&
      state.completion === attempt

    const run = async () => {
      let retainCheckpoint = false
      try {
        if (!isValid()) return
        if (hasQuestions(sessionID)) return
        if (hasPermissions(sessionID)) {
          // Let OpenCode's auto-approve responder clear transient requests first.
          await wait(permissionDelayMs, token.controller.signal)
        }
        if (!isValid() || isBlocked(sessionID)) return

        const metadata = await resolveCompletionMetadata(sessionID, token.controller.signal)
        if (!metadata || !isValid() || isBlocked(sessionID)) return

        await publishSequence(
          token,
          {
            title: hideChatContent ? "OpenCode" : metadata.title,
            message: notificationMessage(sessionID, "Response finished"),
            priority,
          },
          () => isValid() && !isBlocked(sessionID),
          {
            kind: "completion",
            ownerID: sessionID,
            sessionID,
          },
        )
        if (isValid()) {
          state.deliveredGeneration = generation
          state.baselineDeliveredGeneration = undefined
        }
      } catch (error) {
        if (!isAbortError(error) && !token.cancelled && !disposed) {
          logFailure(formatError("ntfy completion notification", error))
        }
        // Keep the activity checkpoint so a reconnect or restart can retry the
        // completion, but only while this generation is still current.
        if (!disposed && state.generation === generation) {
          retainCheckpoint = true
          persistCheckpoint(sessionID, state, state.idleAt)
        }
      } finally {
        finishToken(token)
        if (state.completion === attempt) state.completion = undefined
        if (!retainCheckpoint && state.generation === generation) {
          removeCheckpoint(sessionID)
        }
      }
    }

    attempt.promise = run()
    return attempt.promise
  }

  const requestAction = (kind: RequestKind) =>
    kind === "question" ? "ntfy question notification" : "ntfy permission notification"

  const notePermissionAnswered = (requestID: string) => {
    answeredPermissions.set(requestID, Date.now())
    if (answeredPermissions.size > 1000) {
      const cutoff = Date.now() - 10 * 60_000
      for (const [id, at] of answeredPermissions) {
        if (at < cutoff) answeredPermissions.delete(id)
      }
      while (answeredPermissions.size > 1000) {
        const oldest = answeredPermissions.keys().next().value
        if (typeof oldest !== "string") break
        answeredPermissions.delete(oldest)
      }
    }
  }

  const forgetRequest = (entry: RequestEntry) => {
    removeRequestIndex(
      entry.kind === "question" ? requests : permissions,
      entry.kind === "question" ? requestIDsBySession : permissionIDsBySession,
      entry,
    )
    if (entry.token) cancelToken(entry.token)
  }

  const permissionIsPending = async (
    sessionID: string,
    requestID: string,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> => {
    if (answeredPermissions.has(requestID)) return false
    const getter = ctx.permission?.get
    const list = ctx.permission?.list
    if (getter) {
      try {
        const result = await runBoundedRequest(
          "ntfy permission lookup",
          signal,
          (requestSignal) => getter({ sessionID, requestID }, { signal: requestSignal }),
        )
        const info = normalizeSessionInfo(result)
        return info !== undefined && (typeof info.id !== "string" || info.id === requestID)
      } catch (error) {
        if (isAbortError(error)) throw error
        if (isNotFoundError(error)) return false
        if (!list) return undefined
      }
    }
    if (list) {
      try {
        const result = await runBoundedRequest(
          "ntfy permission list",
          signal,
          (requestSignal) => list({ sessionID }, { signal: requestSignal }),
        )
        const items = Array.isArray(result) ? result : normalizeListData(result)
        return items.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as Readonly<Record<string, unknown>>).id === requestID,
        )
      } catch (error) {
        if (isAbortError(error)) throw error
        return undefined
      }
    }
    return undefined
  }

  const reconcilePermissionSession = (
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const list = ctx.permission?.list
    if (!list || disposed || inactiveSessions.has(sessionID)) return Promise.resolve()
    const existing = permissionReconciles.get(sessionID)
    if (existing) return existing
    const task = (async () => {
      if (isOutsideSession(sessionID) || sessionStates.get(sessionID)?.archived) return
      const existing = new Set(permissionIDsBySession.get(sessionID) ?? [])
      let items: readonly unknown[]
      try {
        const result = await runBoundedRequest(
          "ntfy permission reconciliation",
          signal,
          (requestSignal) => list({ sessionID }, { signal: requestSignal }),
        )
        items = Array.isArray(result) ? result : normalizeListData(result)
      } catch (error) {
        if (!isAbortError(error) && !disposed) {
          logFailure(formatError("ntfy permission reconciliation", error))
        }
        return
      }
      const pending: Array<{ id: string; sessionID: string }> = []
      const pendingIDs = new Set<string>()
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue
        const record = item as Readonly<Record<string, unknown>>
        if (typeof record.id !== "string" || typeof record.sessionID !== "string") continue
        pendingIDs.add(record.id)
        if (answeredPermissions.has(record.id)) continue
        pending.push({ id: record.id, sessionID: record.sessionID })
      }
      for (const requestID of existing) {
        if (!pendingIDs.has(requestID) && !answeredPermissions.has(requestID)) {
          await dismissRequest("permission", requestID)
        }
      }
      for (const request of pending) {
        if (disposed) return
        await notifyRequest("permission", request.id, request.sessionID)
      }
    })()
    permissionReconciles.set(sessionID, task)
    void task.finally(() => {
      if (permissionReconciles.get(sessionID) === task) permissionReconciles.delete(sessionID)
    })
    return task
  }

  const handlePermissionEvaluation = (evaluation: {
    readonly sessionID?: unknown
    readonly effect?: unknown
  }) => {
    if (disposed || !ctx.permission?.list) return
    if (typeof evaluation.sessionID !== "string") return
    // Allow evaluations are high volume. A later escalation emits
    // permission.asked, which goes through the native pending-check path.
    if (evaluation.effect !== "ask") return
    const sessionID = evaluation.sessionID
    if (permissionAdvisories.has(sessionID)) return
    const controller = new AbortController()
    permissionAdvisories.set(sessionID, controller)
    liveControllers.add(controller)
    const cleanup = () => {
      liveControllers.delete(controller)
      if (permissionAdvisories.get(sessionID) === controller) {
        permissionAdvisories.delete(sessionID)
      }
    }
    const task = (async () => {
      try {
        await wait(permissionDelayMs, controller.signal)
        if (disposed || controller.signal.aborted) return
        // The evaluate hook runs before publication and later hooks may change the
        // effect, so only the permission API is authoritative here.
        await reconcilePermissionSession(sessionID, controller.signal)
      } catch (error) {
        if (!isAbortError(error) && !disposed) {
          logFailure(formatError("ntfy permission advisory", error))
        }
      } finally {
        cleanup()
      }
    })()
    trackDetached(task)
    void task.then(cleanup, cleanup)
  }

  const handleRetry = (
    sessionID: string,
    attempt: number | undefined,
    willRetry: boolean,
  ) => {
    if (!willRetry || disposed) return Promise.resolve()
    return noteRetryActivity(sessionID, attempt)
  }

  const runRequestNotification = async (entry: RequestEntry, token: AlertToken) => {
    const entries = entry.kind === "question" ? requests : permissions
    const action = requestAction(entry.kind)
    const owned = () =>
      !disposed &&
      !token.cancelled &&
      !inactiveSessions.has(entry.sessionID) &&
      entries.get(entry.id) === entry &&
      entry.token === token
    const isCurrent = () => owned() && !isOutsideSession(entry.sessionID)
    try {
      if (entry.kind === "permission") {
        // Let OpenCode's auto-approve responder clear transient requests first.
        await wait(permissionDelayMs, token.controller.signal)
        if (!owned()) return
        if (ctx.permission?.list || ctx.permission?.get) {
          const pending = await permissionIsPending(
            entry.sessionID,
            entry.id,
            token.controller.signal,
          )
          if (!owned()) return
          if (pending === false) {
            forgetRequest(entry)
            return
          }
        }
      }
      if (!owned()) return

      const title = await resolveRequestTitle(entry.sessionID, token.controller.signal, action)
      if (!owned()) return
      if (
        isOutsideSession(entry.sessionID) ||
        inactiveSessions.has(entry.sessionID) ||
        sessionStates.get(entry.sessionID)?.archived
      ) {
        // Never leave an entry stuck in publishing when its lookup proves the
        // request belongs to another workspace or a removed session.
        forgetRequest(entry)
        return
      }

      await publishSequence(
        token,
        {
          title: hideChatContent ? "OpenCode" : title,
          message: notificationMessage(
            entry.sessionID,
            entry.kind === "question" ? "Question posed" : "Permissions request",
          ),
          priority,
        },
        isCurrent,
        {
          kind: entry.kind,
          ownerID: entry.id,
          sessionID: entry.sessionID,
        },
      )
      if (isCurrent()) entry.delivery = "delivered"
    } catch (error) {
      if (!isAbortError(error) && !token.cancelled && !disposed) {
        if (entries.get(entry.id) === entry) entry.delivery = "failed"
        logFailure(formatError(action, error))
      }
    } finally {
      finishToken(token)
    }
  }

  const notifyRequest = (kind: RequestKind, id: string, sessionID: string) => {
    if (
      disposed ||
      inactiveSessions.has(sessionID) ||
      sessionStates.get(sessionID)?.archived ||
      isOutsideSession(sessionID) ||
      (kind === "permission" && answeredPermissions.has(id))
    ) {
      return Promise.resolve()
    }
    const entries = kind === "question" ? requests : permissions
    let entry = entries.get(id)
    if (entry) {
      // Successful or in-flight duplicate events must not publish again.
      if (entry.delivery === "publishing" || entry.delivery === "delivered") {
        return Promise.resolve()
      }
    } else {
      entry = {
        kind,
        id,
        sessionID,
        sequenceID: kind === "question" ? questionSequenceID(id) : permissionSequenceID(id),
        delivery: "idle",
      }
      addRequestIndex(entries, kind === "question" ? requestIDsBySession : permissionIDsBySession, entry)
      // A newly pending request invalidates an older in-flight completion.
      if (sessionID !== "global") {
        entry.invalidation = invalidateForRequest(sessionID)
        void entry.invalidation.catch(() => {})
      }
    }

    entry.delivery = "publishing"
    const token = newToken(entry.sequenceID)
    entry.token = token
    return runRequestNotification(entry, token)
  }

  const dismissRequest = (kind: RequestKind, id: string) => {
    const entries = kind === "question" ? requests : permissions
    const entry = entries.get(id)
    if (!entry) return Promise.resolve()
    removeRequestIndex(
      entries,
      kind === "question" ? requestIDsBySession : permissionIDsBySession,
      entry,
    )
    if (entry.token) cancelToken(entry.token)
    return clearSequence(entry.sequenceID)
  }

  const dismissSessionRequests = async (sessionID: string) => {
    const questionIDs = [...(requestIDsBySession.get(sessionID) ?? [])]
    const permissionIDs = [...(permissionIDsBySession.get(sessionID) ?? [])]
    await Promise.all([
      ...questionIDs.map((id) => dismissRequest("question", id)),
      ...permissionIDs.map((id) => dismissRequest("permission", id)),
    ])
  }

  const cancelSessionWork = async (sessionID: string, releaseMetadata: boolean) => {
    inactiveSessions.add(sessionID)
    const state = sessionStates.get(sessionID)
    let generation: number | undefined
    let incarnation: number | undefined
    if (state) {
      state.generation++
      state.running = true
      state.deliveredGeneration = undefined
      cancelCompletionAttempt(state)
      generation = state.generation
      incarnation = state.incarnation
    }
    removeCheckpoint(sessionID)
    await Promise.all([
      dismissSessionRequests(sessionID),
      dismissCompletion(sessionID, true),
    ])
    if (
      releaseMetadata &&
      state &&
      sessionStates.get(sessionID) === state &&
      state.generation === generation &&
      state.incarnation === incarnation
    ) {
      sessionTombstones.set(sessionID, {
        sequences: new Map(state.eventSequences),
        ...(state.serverCreated === undefined ? {} : { serverCreated: state.serverCreated }),
      })
      if (sessionTombstones.size > 2048) {
        const oldest = sessionTombstones.keys().next().value
        if (typeof oldest === "string") sessionTombstones.delete(oldest)
      }
      sessionStates.delete(sessionID)
    }
  }

  // Moving away is not archival: keep the session usable if it moves back.
  const suspendSession = async (sessionID: string) => {
    const state = ensureSessionState(sessionID)
    state.generation++
    state.running = true
    state.deliveredGeneration = undefined
    cancelCompletionAttempt(state)
    removeCheckpoint(sessionID)
    await Promise.all([
      dismissSessionRequests(sessionID),
      dismissCompletion(sessionID),
    ])
  }

  const handleSessionCreated = (
    sessionID: string,
    data: Readonly<Record<string, unknown>>,
  ) => {
    inactiveSessions.delete(sessionID)
    sessionTombstones.delete(sessionID)
    const state = ensureSessionState(sessionID)
    state.generation++
    state.incarnation++
    state.archived = false
    state.completionBlocked = false
    state.deliveredGeneration = undefined
    state.outcome = undefined
    state.idleAt = undefined
    state.lastRetryAttempt = undefined
    state.pendingPrompt = false
    mergeSessionInfo(sessionID, data)
  }

  const eventIsOutdated = (state: SessionState, watermark: EventWatermark) => {
    if (
      watermark.aggregateID !== undefined &&
      watermark.seq !== undefined &&
      Number.isFinite(watermark.seq)
    ) {
      const previous = state.eventSequences.get(watermark.aggregateID)
      return previous !== undefined && watermark.seq <= previous
    }
    return (
      watermark.created !== undefined &&
      state.serverCreated !== undefined &&
      watermark.created < state.serverCreated
    )
  }

  const recordNativeEvent = (sessionID: string, watermark: EventWatermark) => {
    const state = ensureSessionState(sessionID)
    if (eventIsOutdated(state, watermark)) return false
    if (watermark.aggregateID !== undefined && watermark.seq !== undefined) {
      state.eventSequences.set(watermark.aggregateID, watermark.seq)
    }
    if (watermark.created !== undefined) {
      state.serverCreated =
        state.serverCreated === undefined
          ? watermark.created
          : Math.max(state.serverCreated, watermark.created)
    }
    touchSession(state)
    return true
  }

  const processEvent = async (event: NotificationEvent) => {
    if (disposed) return
    if (!relevantEventTypeSet.has(event.type)) return
    const eventSessionID = sessionIDFromEvent(event)
    const state =
      eventSessionID === undefined ? undefined : sessionStates.get(eventSessionID)
    const identity = eventIdentity(event, state)
    if (eventSessionID !== undefined && state && !isOutsideWorkspace(identity)) {
      rememberEventIdentity(eventSessionID, identity)
    }
    // Cleanup events must still clear alerts even when their metadata is elsewhere.
    if (isOutsideWorkspace(identity) && !notificationClearingEventTypes.has(event.type)) {
      return
    }

    try {
      switch (event.type) {
        case "session.created": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          handleSessionCreated(
            sessionID,
            event.data as unknown as Readonly<Record<string, unknown>>,
          )
          break
        }
        case "session.renamed": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          ensureSessionState(sessionID).title = event.data.title
          break
        }
        case "session.moved": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          const session = ensureSessionState(sessionID)
          const eventLocation = event.data.location as Readonly<Record<string, unknown>>
          setSessionDirectory(
            session,
            event.data.location.directory,
            typeof eventLocation.workspaceID === "string"
              ? eventLocation.workspaceID
              : undefined,
          )
          if (typeof event.data.projectID === "string") {
            session.projectID = event.data.projectID
          }
          if (isOutsideSession(sessionID)) await suspendSession(sessionID)
          break
        }
        case "session.deleted": {
          if (!recordNativeEvent(event.data.sessionID, eventWatermark(event))) break
          await cancelSessionWork(event.data.sessionID, true)
          break
        }
        case "session.archived": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          ensureSessionState(sessionID).archived = true
          await cancelSessionWork(sessionID, false)
          break
        }
        case "session.unarchived": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          inactiveSessions.delete(sessionID)
          const session = ensureSessionState(sessionID)
          session.archived = false
          session.completionBlocked = false
          session.generation++
          session.incarnation++
          session.running = false
          session.deliveredGeneration = undefined
          cancelCompletionAttempt(session)
          break
        }
        case "session.execution.started": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          const session = ensureSessionState(sessionID)
          session.outcome = undefined
          session.idleAt = undefined
          session.lastRetryAttempt = undefined
          session.completionBlocked = false
          await invalidateForActivity(
            sessionID,
            true,
            typeof event.created === "number" ? event.created : undefined,
          )
          break
        }
        case "session.execution.succeeded": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          const session = ensureSessionState(sessionID)
          session.outcome = "succeeded"
          // The first authoritative success after an initial baseline may notify.
          // A later same-generation success must not republish a delivered alert.
          if (
            session.deliveredGeneration === session.generation &&
            session.baselineDeliveredGeneration === session.generation
          ) {
            session.deliveredGeneration = undefined
            session.baselineDeliveredGeneration = undefined
          }
          if (typeof event.created === "number") session.idleAt = event.created
          await notifyFinished(sessionID)
          break
        }
        case "session.execution.failed":
        case "session.execution.interrupted": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          const session = ensureSessionState(sessionID)
          // A failed or interrupted execution must never surface as "Response finished".
          session.outcome =
            event.type === "session.execution.failed" ? "failed" : "interrupted"
          session.completionBlocked = true
          session.running = false
          session.generation++
          session.deliveredGeneration = undefined
          cancelCompletionAttempt(session)
          removeCheckpoint(sessionID)
          await dismissCompletion(sessionID)
          break
        }
        case "session.retry.scheduled": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          await noteRetryActivity(
            sessionID,
            event.data.attempt,
            typeof event.created === "number" ? event.created : undefined,
          )
          break
        }
        case "session.status": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          const status = event.data.status
          if (status.type === "idle") {
            await notifyFinished(sessionID)
          } else if (status.type === "retry") {
            await noteRetryActivity(
              sessionID,
              status.attempt,
              typeof event.created === "number" ? event.created : undefined,
            )
          } else if (status.type === "busy") {
            await invalidateForActivity(
              sessionID,
              false,
              typeof event.created === "number" ? event.created : undefined,
            )
          }
          break
        }
        case "session.idle": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          await notifyFinished(sessionID)
          break
        }
        case "form.created": {
          if (!recordNativeEvent(event.data.form.sessionID, eventWatermark(event))) break
          await notifyRequest("question", event.data.form.id, event.data.form.sessionID)
          break
        }
        case "form.replied":
        case "form.cancelled": {
          await dismissRequest("question", event.data.id)
          break
        }
        case "permission.asked": {
          if (!recordNativeEvent(event.data.sessionID, eventWatermark(event))) break
          await notifyRequest("permission", event.data.id, event.data.sessionID)
          break
        }
        case "permission.replied": {
          notePermissionAnswered(event.data.requestID)
          await dismissRequest("permission", event.data.requestID)
          break
        }
      }
    } catch (error) {
      if (!isAbortError(error) && !disposed) {
        logFailure(formatError("ntfy event handling", error))
      }
    }
  }

  const handleEvent = (incoming: NotificationEvent) => {
    if (disposed) return Promise.resolve()
    if (!started || reconciling) {
      markBufferedEvent(incoming)
      if (bufferedEvents.length < maximumBufferedEvents) {
        bufferedEvents.push(incoming)
      } else if (!bufferOverflowReported) {
        bufferOverflowReported = true
        logFailure(
          "event buffer overflow during reconciliation; newest live events will be dropped",
        )
      }
      return Promise.resolve()
    }
    return Promise.resolve().then(() => processEvent(incoming))
  }

  const drainBufferedEvents = () => {
    while (bufferedEvents.length > 0 && started && !reconciling) {
      const event = bufferedEvents.shift()
      if (!event) break
      const task = processEvent(event)
      trackDetached(task)
      void task.catch((error) => {
        if (!isAbortError(error) && !disposed) {
          console.error(
            `[opencode-ntfy] notification task failed: ${oneLine(
              error instanceof Error ? error.message : error,
              maximumFailureLength,
            )}`,
          )
        }
      })
    }
    if (bufferedEvents.length === 0) bufferOverflowReported = false
  }

  const handlePrompt = async (sessionID: string) => {
    if (disposed || inactiveSessions.has(sessionID)) return
    try {
      const state = ensureSessionState(sessionID)
      state.lastRetryAttempt = undefined
      touchSession(state)
      markDirtySession(sessionID, ++eventEpoch)
      await invalidateForActivity(sessionID, true, undefined, { prompt: true })
    } catch (error) {
      if (!isAbortError(error) && !disposed) {
        logFailure(formatError("ntfy prompt handling", error))
      }
    }
  }

  const isNotFoundError = (error: unknown) => {
    if (typeof error !== "object" || error === null) return false
    const record = error as {
      status?: unknown
      statusCode?: unknown
      cause?: unknown
      message?: unknown
    }
    if (record.status === 404 || record.statusCode === 404) return true
    if (
      typeof record.cause === "object" &&
      record.cause !== null &&
      ((record.cause as { status?: unknown }).status === 404 ||
        (record.cause as { statusCode?: unknown }).statusCode === 404)
    ) {
      return true
    }
    return typeof record.message === "string" && /\b404\b|not found/i.test(record.message)
  }

  const sessionInfoID = (info: Readonly<Record<string, unknown>>) =>
    typeof info.id === "string"
      ? info.id
      : typeof info.sessionID === "string"
        ? info.sessionID
        : undefined

  const sessionInfoActive = (info: Readonly<Record<string, unknown>>) => {
    if (info.outcome !== undefined) return false
    const time =
      typeof info.time === "object" && info.time !== null
        ? (info.time as Readonly<Record<string, unknown>>)
        : undefined
    if (time?.idle !== undefined) return false
    return (
      typeof time?.created === "number" &&
      typeof time.updated === "number" &&
      time.updated > time.created
    )
  }

  const listSessions = async (
    signal: AbortSignal,
  ): Promise<Map<string, Readonly<Record<string, unknown>>> | undefined> => {
    const list = ctx.session.list
    if (!list) return undefined
    const sessions = new Map<string, Readonly<Record<string, unknown>>>()
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const response = await runBoundedRequest(
        "ntfy session reconciliation",
        signal,
        (requestSignal) =>
          list(
            {
              limit: 100,
              ...(locationDirectory === undefined ? {} : { directory: locationDirectory }),
              ...(cursor === undefined ? {} : { cursor }),
            },
            { signal: requestSignal },
          ),
      )
      const items = Array.isArray(response)
        ? response
        : normalizeListData(response)
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue
        const info = item as Readonly<Record<string, unknown>>
        const id = sessionInfoID(info)
        if (id !== undefined) sessions.set(id, info)
        if (sessions.size > maximumStoredSessions * 4) return sessions
      }
      const responseRecord =
        typeof response === "object" && response !== null
          ? (response as Readonly<Record<string, unknown>>)
          : undefined
      const cursorRecord =
        typeof responseRecord?.cursor === "object" && responseRecord.cursor !== null
          ? (responseRecord.cursor as Readonly<Record<string, unknown>>)
          : undefined
      const next = cursorRecord?.next
      if (typeof next !== "string" || next.length === 0 || next === cursor) break
      cursor = next
    }
    return sessions
  }

  const noteCheckpointIdentity = (
    state: SessionState,
    checkpoint: SessionCheckpoint | undefined,
  ) => {
    if (!checkpoint || checkpoint.directory === undefined) return
    if (state.location !== checkpoint.directory) return
    if (state.workspaceID === undefined && checkpoint.workspaceID !== undefined) {
      state.workspaceID = checkpoint.workspaceID
    }
    if (state.projectID === undefined && checkpoint.projectID !== undefined) {
      state.projectID = checkpoint.projectID
    }
  }

  const shouldRecoverCompletion = (
    state: SessionState,
    checkpoint: SessionCheckpoint | undefined,
  ) => {
    if (!checkpoint || state.pendingPrompt) return false
    if (state.outcome !== "succeeded" || state.idleAt === undefined) return false
    if (checkpoint.since !== undefined && state.idleAt < checkpoint.since) return false
    return true
  }

  const prepareRecoveredCompletion = (state: SessionState) => {
    state.generation++
    state.running = false
    state.completionBlocked = false
    state.deliveredGeneration = undefined
    state.baselineDeliveredGeneration = undefined
    cancelCompletionAttempt(state)
  }

  const reconcileStartupOutbox = async (
    confirmedMissing: ReadonlySet<string>,
    reconcileEpoch: number,
    signal: AbortSignal,
  ) => {
    if (restoredOutbox.size === 0) return
    const pendingPermissions: Array<{ record: OutboxRecord }> = []
    for (const [sequenceID, record] of [...restoredOutbox]) {
      if (isDirtySince(record.sessionID, reconcileEpoch)) continue
      if (confirmedMissing.has(record.sessionID)) {
        await clearSequence(sequenceID, { force: true })
        restoredOutbox.delete(sequenceID)
        continue
      }
      if (record.kind === "question") {
        // Public Plugin.Context cannot query forms, so a question alert restored
        // after a restart cannot be verified and is cleared conservatively.
        await clearSequence(sequenceID, { force: true })
        restoredOutbox.delete(sequenceID)
        continue
      }
      if (record.kind === "permission") {
        const pending = await permissionIsPending(
          record.sessionID,
          record.ownerID,
          signal,
        )
        if (pending === false) {
          await clearSequence(sequenceID, { force: true })
        } else if (pending === true) {
          // Republishing the same sequence ID refreshes the existing alert
          // without clearing a permission that is still valid.
          pendingPermissions.push({ record })
        }
        // Unknown verification keeps the existing alert rather than losing a
        // possibly pending permission.
        restoredOutbox.delete(sequenceID)
        continue
      }
      await clearSequence(sequenceID, { force: true })
      restoredOutbox.delete(sequenceID)
    }
    for (const { record } of pendingPermissions) {
      if (
        disposed ||
        answeredPermissions.has(record.ownerID) ||
        isDirtySince(record.sessionID, reconcileEpoch)
      ) {
        continue
      }
      await notifyRequest("permission", record.ownerID, record.sessionID)
    }
  }

  const reconcileMissingSessions = async (
    snapshot: Map<string, Readonly<Record<string, unknown>>>,
    confirmedMissing: Set<string>,
    recovery: Set<string>,
    snapshotRevision: number,
    reconcileEpoch: number,
    signal: AbortSignal,
  ) => {
    const candidates = new Set<string>()
    for (const sessionID of sessionStates.keys()) candidates.add(sessionID)
    for (const sessionID of storedCheckpoints.keys()) candidates.add(sessionID)
    for (const record of restoredOutbox.values()) candidates.add(record.sessionID)
    for (const sessionID of requestIDsBySession.keys()) candidates.add(sessionID)
    for (const sessionID of permissionIDsBySession.keys()) candidates.add(sessionID)
    candidates.delete("global")
    const missing = [...candidates]
      .filter(
        (sessionID) =>
          !snapshot.has(sessionID) && !isDirtySince(sessionID, reconcileEpoch),
      )
      .slice(0, maximumReconcileLookups)

    await mapWithConcurrency(missing, reconcileConcurrency, async (sessionID) => {
      if (disposed || isDirtySince(sessionID, reconcileEpoch)) return
      let info: Readonly<Record<string, unknown>> | undefined
      try {
        info = await getSessionBounded(sessionID, signal, "ntfy session reconciliation")
      } catch (error) {
        if (isAbortError(error) || disposed) return
        if (isDirtySince(sessionID, reconcileEpoch)) return
        if (isNotFoundError(error)) {
          confirmedMissing.add(sessionID)
          // A definite 404 is deletion, not a temporary move-out. Mark it
          // inactive and retain its durable watermark so idle fallbacks cannot
          // republish for the missing session.
          await cancelSessionWork(sessionID, true)
        } else {
          // A partial or filtered snapshot is not proof of deletion.
          logFailure(formatError("ntfy session reconciliation", error))
        }
        return
      }
      if (!info || disposed || isDirtySince(sessionID, reconcileEpoch)) return
      const state = mergeSessionInfo(sessionID, info, snapshotRevision)
      noteCheckpointIdentity(state, storedCheckpoints.get(sessionID))
      if (state.archived) {
        state.running = false
        if (state.deliveredGeneration === undefined) {
          state.deliveredGeneration = state.generation
        }
        if (sequenceStates.get(completionSequenceID(sessionID))?.possibleActive) {
          await dismissCompletion(sessionID, true)
        }
        await dismissSessionRequests(sessionID)
        removeCheckpoint(sessionID)
        return
      }
      if (isOutsideSession(sessionID)) {
        await suspendSession(sessionID)
        removeCheckpoint(sessionID)
        return
      }
      if (state.outcome === "failed" || state.outcome === "interrupted") {
        state.running = false
        state.completionBlocked = true
        state.deliveredGeneration = state.generation
        if (sequenceStates.get(completionSequenceID(sessionID))?.possibleActive) {
          await dismissCompletion(sessionID, true)
        }
        removeCheckpoint(sessionID)
        return
      }
      const checkpoint = storedCheckpoints.get(sessionID)
      if ((state.running || checkpoint !== undefined) && shouldRecoverCompletion(state, checkpoint)) {
        recovery.add(sessionID)
        return
      }
      if (sessionInfoActive(info)) {
        state.running = true
        state.deliveredGeneration = undefined
        persistCheckpoint(sessionID, state)
      } else {
        state.running = false
        if (state.deliveredGeneration === undefined) {
          state.deliveredGeneration = state.generation
          state.baselineDeliveredGeneration = state.generation
        }
        removeCheckpoint(sessionID)
      }
    })
  }

  const reconcileOnce = async () => {
    const controller = new AbortController()
    liveControllers.add(controller)
    try {
      const reconcileEpoch = eventEpoch
      const snapshotRevision = sessionRevision
      let snapshot = await listSessions(controller.signal)

      if (
        snapshot === undefined &&
        (restoredOutbox.size > 0 || storedCheckpoints.size > 0)
      ) {
        // Older or mock contexts may not expose session.list. Reconstruct only
        // the sessions referenced by durable records.
        const ids = new Set<string>()
        for (const record of restoredOutbox.values()) ids.add(record.sessionID)
        for (const sessionID of storedCheckpoints.keys()) ids.add(sessionID)
        const fallback = new Map<string, Readonly<Record<string, unknown>>>()
        await mapWithConcurrency([...ids], reconcileConcurrency, async (sessionID) => {
          if (isDirtySince(sessionID, reconcileEpoch)) return
          try {
            const info = await getSessionBounded(
              sessionID,
              controller.signal,
              "ntfy reconciliation",
            )
            if (info) fallback.set(sessionID, info)
          } catch (error) {
            if (!isAbortError(error) && !disposed) {
              logFailure(formatError("ntfy reconciliation", error))
            }
          }
        })
        if (fallback.size > 0) snapshot = fallback
      }

      if (snapshot !== undefined) {
        const confirmedMissing = new Set<string>()
        const recovery = new Set<string>()

        for (const [sessionID, info] of snapshot) {
          if (isDirtySince(sessionID, reconcileEpoch)) continue
          const state = mergeSessionInfo(sessionID, info, snapshotRevision)
          if (state.revision <= snapshotRevision) {
            noteCheckpointIdentity(state, storedCheckpoints.get(sessionID))
          }
        }

        // A filtered or capped list is not an inventory. Resolve every known
        // session that is absent through a bounded lookup before treating it as
        // gone or changed.
        await reconcileMissingSessions(
          snapshot,
          confirmedMissing,
          recovery,
          snapshotRevision,
          reconcileEpoch,
          controller.signal,
        )

        if (!initialSnapshotComplete || restoredOutbox.size > 0) {
          await reconcileStartupOutbox(
            confirmedMissing,
            reconcileEpoch,
            controller.signal,
          )
        }

        for (const [sessionID] of snapshot) {
          if (isDirtySince(sessionID, reconcileEpoch)) continue
          const state = sessionStates.get(sessionID)
          if (!state || state.revision > snapshotRevision) continue
          const checkpoint = storedCheckpoints.get(sessionID)
          const wasTracked = state.running
          if (
            (wasTracked || checkpoint !== undefined) &&
            shouldRecoverCompletion(state, checkpoint)
          ) {
            recovery.add(sessionID)
          }
        }

        for (const sessionID of recovery) {
          if (disposed || isDirtySince(sessionID, reconcileEpoch)) continue
          const state = sessionStates.get(sessionID)
          if (!state) continue
          prepareRecoveredCompletion(state)
          await dismissCompletion(sessionID, true)
          // A live event that arrived while the clear was in flight wins; leave
          // the checkpoint for a later reconcile.
          if (disposed || isDirtySince(sessionID, reconcileEpoch)) continue
          await notifyFinished(sessionID)
        }

        for (const [sessionID, info] of snapshot) {
          if (disposed || isDirtySince(sessionID, reconcileEpoch)) continue
          const state = sessionStates.get(sessionID)
          if (!state || state.revision > snapshotRevision) continue
          if (recovery.has(sessionID)) continue
          if (state.archived) {
            state.running = false
            if (state.deliveredGeneration === undefined) {
              state.deliveredGeneration = state.generation
            }
            if (sequenceStates.get(completionSequenceID(sessionID))?.possibleActive) {
              await dismissCompletion(sessionID, true)
            }
            await dismissSessionRequests(sessionID)
            removeCheckpoint(sessionID)
            continue
          }
          if (isOutsideSession(sessionID)) {
            await suspendSession(sessionID)
            removeCheckpoint(sessionID)
            continue
          }
          if (state.outcome === "failed" || state.outcome === "interrupted") {
            state.running = false
            state.completionBlocked = true
            state.deliveredGeneration = state.generation
            if (sequenceStates.get(completionSequenceID(sessionID))?.possibleActive) {
              await dismissCompletion(sessionID, true)
            }
            removeCheckpoint(sessionID)
            continue
          }
          if (sessionInfoActive(info)) {
            state.running = true
            state.deliveredGeneration = undefined
            persistCheckpoint(sessionID, state)
          } else {
            state.running = false
            if (state.deliveredGeneration === undefined) {
              state.deliveredGeneration = state.generation
            }
            removeCheckpoint(sessionID)
          }
        }

        const permissionCandidates = new Set<string>()
        for (const [sessionID, info] of snapshot) {
          if (isDirtySince(sessionID, reconcileEpoch)) continue
          const state = sessionStates.get(sessionID)
          if (!state || state.revision > snapshotRevision) continue
          if (sessionInfoActive(info) || state.running) permissionCandidates.add(sessionID)
        }
        for (const sessionID of permissionIDsBySession.keys()) {
          if (!isDirtySince(sessionID, reconcileEpoch)) {
            permissionCandidates.add(sessionID)
          }
        }
        if (permissionCandidates.size > 0) {
          await mapWithConcurrency(
            [...permissionCandidates].slice(0, maximumPermissionReconciles),
            reconcileConcurrency,
            (sessionID) => reconcilePermissionSession(sessionID, controller.signal),
          )
        }

        initialSnapshotComplete = true
      }
    } finally {
      liveControllers.delete(controller)
    }
  }

  const reconcile = () => {
    if (disposed) return Promise.resolve()
    if (reconcilePromise) {
      reconcileRequested = true
      return reconcilePromise
    }
    reconciling = true
    reconcilePromise = (async () => {
      try {
        await reconcileOnce()
      } catch (error) {
        if (!isAbortError(error) && !disposed) {
          logFailure(formatError("ntfy reconciliation", error))
        }
      } finally {
        reconciling = false
        started = true
        reconcilePromise = undefined
        drainBufferedEvents()
        if (reconcileRequested && !disposed) {
          reconcileRequested = false
          await reconcile()
        }
      }
    })()
    return reconcilePromise
  }

  const dispose = () => {
    if (disposePromise) return disposePromise
    disposed = true
    const sequences = new Set<string>(sequenceStates.keys())
    for (const sequenceID of persistedSequences) sequences.add(sequenceID)
    for (const entry of requests.values()) sequences.add(entry.sequenceID)
    for (const entry of permissions.values()) sequences.add(entry.sequenceID)
    for (const state of sessionStates.values()) {
      if (state.completion) sequences.add(state.completion.token.sequenceID)
    }

    for (const token of [...activeTokens]) cancelToken(token)
    for (const controller of [...liveControllers]) controller.abort()

    disposePromise = (async () => {
      await Promise.all(
        [...sequences].map((sequenceID) =>
          clearSequence(sequenceID, { force: true, shutdown: true }),
        ),
      )
      await Promise.allSettled([...detachedTasks])
      await Promise.allSettled([...checkpointChains.values()])
      requests.clear()
      permissions.clear()
      requestIDsBySession.clear()
      permissionIDsBySession.clear()
      sessionStates.clear()
      inactiveSessions.clear()
      sequenceStates.clear()
      sequenceChains.clear()
      checkpointChains.clear()
      permissionReconciles.clear()
      permissionAdvisories.clear()
      activeTokens.clear()
      liveControllers.clear()
      detachedTasks.clear()
      bufferedEvents.length = 0
      restoredOutbox.clear()
      storedCheckpoints.clear()
    })()
    return disposePromise
  }

  await loadDurableState()
  const runtime = {
    handleEvent,
    handlePrompt,
    handleRetry,
    handlePermissionEvaluation,
    reconcile,
    dispose,
  }
  if (!runtimeOptions.deferReconcile) await reconcile()
  return runtime
}

const maximumReconnectDelayMs = 10_000
const stableConnectionMs = 10_000

const subscriptionDelay = (attempt: number) => {
  const exponential = Math.min(
    maximumReconnectDelayMs,
    250 * 2 ** Math.min(attempt, 16),
  )
  const jitter = exponential * 0.2 * Math.random()
  return Math.min(maximumReconnectDelayMs, exponential + jitter)
}

const subscriptionErrorMessage = (error: unknown) =>
  oneLine(error instanceof Error ? error.message : error, maximumFailureLength)

export async function setupNtfyRuntime(ctx: NtfySetupContext) {
  const runtime = await createNtfyRuntime(ctx, { deferReconcile: true })
  const controller = new AbortController()
  const tasks = new Set<Promise<void>>()
  const registrations: Array<{ dispose: () => Promise<void> | void }> = []
  let reconnectAttempt = 0
  let subscriptionFailures = 0
  let streamStartedAt = 0
  let streamEstablished = false
  let hooksDisposed = false

  const track = (promise: Promise<void>) => {
    tasks.add(promise)
    void promise.then(
      () => tasks.delete(promise),
      (error) => {
        tasks.delete(promise)
        if (!controller.signal.aborted && !isAbortError(error)) {
          console.error(`[opencode-ntfy] notification task failed: ${subscriptionErrorMessage(error)}`)
        }
      },
    )
  }

  const logFailure = (message: string) => {
    console.error(`[opencode-ntfy] ${oneLine(message, maximumFailureLength)}`)
  }

  const disposeHooks = async () => {
    if (hooksDisposed) return
    hooksDisposed = true
    for (const registration of [...registrations].reverse()) {
      try {
        await registration.dispose()
      } catch (error) {
        if (!isAbortError(error)) {
          logFailure(`notification hook disposal failed: ${subscriptionErrorMessage(error)}`)
        }
      }
    }
    registrations.length = 0
  }

  try {
    if (ctx.permission?.hook) {
      const registration = await ctx.permission.hook("evaluate", (evaluation) => {
        try {
          runtime.handlePermissionEvaluation(evaluation)
        } catch (error) {
          if (!isAbortError(error)) {
            logFailure(`permission evaluation handling failed: ${subscriptionErrorMessage(error)}`)
          }
        }
      })
      if (registration && typeof registration.dispose === "function") {
        registrations.push(registration)
      }
    }

    const retryRegistration = await ctx.session.hook("retry", (event) => {
      // Never make OpenCode wait for ntfy I/O.
      track(
        (async () => {
          await runtime.handleRetry(
            event.sessionID,
            event.attempt,
            event.decision?.retry === true,
          )
        })(),
      )
    })
    if (retryRegistration && typeof retryRegistration.dispose === "function") {
      registrations.push(retryRegistration)
    }

    const promptRegistration = await ctx.session.hook("prompt", (event) => {
      // Never make OpenCode wait for ntfy I/O.
      track(
        (async () => {
          await runtime.handlePrompt(event.sessionID)
        })(),
      )
    })
    if (promptRegistration && typeof promptRegistration.dispose === "function") {
      registrations.push(promptRegistration)
    }
  } catch (error) {
    await disposeHooks()
    await runtime.dispose()
    throw error
  }

  const establishStreamIfStable = () => {
    if (streamEstablished) return
    if (performance.now() - streamStartedAt < stableConnectionMs) return
    streamEstablished = true
    reconnectAttempt = 0
    if (subscriptionFailures > 0) {
      logFailure("event subscription recovered")
      subscriptionFailures = 0
    }
  }

  const consume = async () => {
    while (!controller.signal.aborted) {
      streamStartedAt = performance.now()
      streamEstablished = false
      try {
        const stream = ctx.event.subscribe({
          types: relevantEventTypes,
          signal: controller.signal,
          onActivity: establishStreamIfStable,
        })
        const iterator = stream[Symbol.asyncIterator]()
        let pending = iterator.next()
        // The subscription is opened before the snapshot so events that arrive
        // during reconciliation are buffered instead of lost.
        track(runtime.reconcile())
        for (;;) {
          const result = await pending
          if (result.done) break
          if (controller.signal.aborted) break
          const event = result.value
          establishStreamIfStable()
          if (!relevantEventTypeSet.has(event.type)) {
            pending = iterator.next()
            continue
          }
          track(runtime.handleEvent(event))
          pending = iterator.next()
        }
      } catch (error) {
        if (controller.signal.aborted) break
        establishStreamIfStable()
        subscriptionFailures++
        logFailure(`event subscription failed: ${subscriptionErrorMessage(error)}`)
      }

      if (controller.signal.aborted) break
      // A stream that stayed healthy long enough resets backoff even if it was idle.
      establishStreamIfStable()

      // The stream ended without an explicit shutdown; reconnect with bounded backoff.
      if (subscriptionFailures === 0) {
        subscriptionFailures++
        logFailure("event subscription ended unexpectedly; reconnecting")
      }
      const delay = subscriptionDelay(reconnectAttempt)
      reconnectAttempt++
      try {
        await wait(delay, controller.signal)
      } catch {
        break
      }
    }
  }

  const subscriptionTask = consume()
  track(subscriptionTask)

  let cleanupPromise: Promise<void> | undefined
  return () => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      controller.abort()
      await disposeHooks()
      await runtime.dispose()
      await Promise.allSettled([...tasks, subscriptionTask])
    })()
    return cleanupPromise
  }
}

export default Plugin.define({
  id: "opencode-ntfy",
  async setup(ctx) {
    assertSupportedHost(ctx)
    return setupNtfyRuntime(ctx)
  },
})
