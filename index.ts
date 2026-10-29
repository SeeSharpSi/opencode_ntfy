import { Plugin } from "@opencode/plugin"
import type { OpenCodeEvent } from "@opencode/client"
import {
  request as sendRequest,
  wait,
  type DeliveryPolicy,
} from "./transport.js"

type NtfyContext = {
  readonly options?: Readonly<Record<string, unknown>>
  readonly location?: {
    readonly directory?: string
  }
  readonly session: {
    get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<unknown>
  }
}

type NtfySubscriptionOptions = {
  readonly signal?: AbortSignal
  readonly types?: readonly string[]
}

type NtfySetupContext = NtfyContext & {
  readonly event: {
    subscribe(options?: NtfySubscriptionOptions): AsyncIterable<OpenCodeEvent>
  }
  readonly session: NtfyContext["session"] & {
    hook(
      name: "prompt",
      callback: (event: { sessionID: string }) => Promise<void> | void,
    ): Promise<Registration | void> | Registration | void
  }
}

type Registration = {
  dispose(): Promise<void> | void
}

type ForwardCompatibleSessionEvent = {
  readonly type: "session.archived" | "session.unarchived"
  readonly data: {
    readonly sessionID: string
  }
  readonly location?: {
    readonly directory?: string
  }
}

type NotificationEvent = OpenCodeEvent | ForwardCompatibleSessionEvent

type EventWatermark = {
  aggregateID?: string
  seq?: number
  created?: number
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
  location?: string
  archived: boolean
  generation: number
  running: boolean
  deliveredGeneration?: number
  completion?: CompletionAttempt
  completionBlocked?: boolean
  watermark?: EventWatermark
  promptedAt?: number
}

const defaultPolicy: DeliveryPolicy = {
  requestTimeoutMs: 5000,
  retryAttempts: 3,
  retryDelayMs: 250,
}
const defaultPermissionDelayMs = 100
const maximumFailureLength = 320

const relevantEventTypes = new Set([
  "session.idle",
  "session.status",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
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
])
const relevantEventTypeList = [...relevantEventTypes]

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

const normalizeSessionInfo = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Readonly<Record<string, unknown>>
  const data = record.data
  if (typeof data === "object" && data !== null) {
    return data as Readonly<Record<string, unknown>>
  }
  return record
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

export async function createNtfyRuntime(ctx: NtfyContext) {
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

  const baseUrl = (
    pluginOption("server") ??
    pluginOption("url") ??
    environmentVariable("NTFY_SERVER") ??
    environmentVariable("NTFY_URL") ??
    "https://ntfy.sh"
  ).replace(/\/+$/, "")
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

  const locationDirectory =
    typeof ctx.location?.directory === "string" ? ctx.location.directory : undefined
  const requests = new Map<string, RequestEntry>()
  const permissions = new Map<string, RequestEntry>()
  const requestIDsBySession = new Map<string, Set<string>>()
  const permissionIDsBySession = new Map<string, Set<string>>()
  const sessionStates = new Map<string, SessionState>()
  const inactiveSessions = new Set<string>()
  const sequenceStates = new Map<string, SequenceState>()
  const sequenceChains = new Map<string, Promise<void>>()
  const activeTokens = new Set<AlertToken>()
  const liveControllers = new Set<AbortController>()

  let disposed = false
  let disposePromise: Promise<void> | undefined
  let lastFailure: string | undefined
  let suppressedFailures = 0

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

  const ensureSessionState = (sessionID: string) => {
    let state = sessionStates.get(sessionID)
    if (!state) {
      state = {
        parentKnown: false,
        archived: false,
        generation: 0,
        running: false,
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
  ) =>
    enqueue(token.sequenceID, async () => {
      if (disposed || token.cancelled || !isValid()) throw abortError()
      const state = ensureSequenceState(token.sequenceID)
      // From this point on the POST may reach ntfy even if it is interrupted.
      state.possibleActive = true
      await sendRequest(
        `${baseUrl}/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ topic, ...message, sequence_id: token.sequenceID }),
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
          { method: "PUT", headers: authHeaders },
          "ntfy notification clear",
          shutdown ? shutdownPolicy : policy,
          controller.signal,
        )
        if (state) state.possibleActive = false
        recordSuccess("ntfy notification clear")
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

  const getSessionBounded = async (
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
        fail(new Error(`${action} failed: session lookup timed out after ${policy.requestTimeoutMs}ms`))
      }, policy.requestTimeoutMs)
    })

    try {
      const lookup = Promise.resolve(ctx.session.get({ sessionID }, { signal: controller.signal }))
      const response = await Promise.race([lookup, stop])
      return normalizeSessionInfo(response)
    } finally {
      settled = true
      cleanup()
      controller.abort()
    }
  }

  const mergeSessionInfo = (
    sessionID: string,
    info: Readonly<Record<string, unknown>> | undefined,
  ) => {
    const state = ensureSessionState(sessionID)
    if (!info) return state
    if (typeof info.title === "string") state.title = info.title
    state.parentKnown = true
    state.parentID = typeof info.parentID === "string" ? info.parentID : undefined
    const location = info.location
    if (typeof location === "object" && location !== null) {
      const directory = (location as Readonly<Record<string, unknown>>).directory
      if (typeof directory === "string") state.location = directory
    }
    const time = info.time
    if (typeof time === "object" && time !== null) {
      const archived = (time as Readonly<Record<string, unknown>>).archived
      state.archived = typeof archived === "number" && archived > 0
    }
    return state
  }

  const resolveRequestTitle = async (
    sessionID: string,
    signal: AbortSignal,
    action: string,
  ) => {
    if (hideChatContent || sessionID === "global") return "OpenCode"
    const state = ensureSessionState(sessionID)
    if (state.title !== undefined) return state.title
    try {
      const info = await getSessionBounded(sessionID, signal, action)
      mergeSessionInfo(sessionID, info)
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
      try {
        const info = await getSessionBounded(sessionID, signal, "ntfy completion notification")
        mergeSessionInfo(sessionID, info)
      } catch (error) {
        if (!isAbortError(error) && !disposed) {
          logFailure(formatError("ntfy completion notification", error))
        }
      }
    }
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

  const invalidateForActivity = (sessionID: string, force: boolean) => {
    const state = ensureSessionState(sessionID)
    // Repeated busy/status events during the same execution are harmless.
    if (!force && state.running && state.completion === undefined) return Promise.resolve()
    state.running = true
    state.generation++
    state.deliveredGeneration = undefined
    state.completionBlocked = false
    cancelCompletionAttempt(state)
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

  const notifyFinished = (sessionID: string) => {
    if (disposed || inactiveSessions.has(sessionID) || hasQuestions(sessionID)) {
      return Promise.resolve()
    }
    const state = ensureSessionState(sessionID)
    if (state.archived || state.completionBlocked) return Promise.resolve()
    state.running = false
    if (state.deliveredGeneration === state.generation) return Promise.resolve()
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
      state.generation === generation &&
      state.completion === attempt

    const run = async () => {
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
            message: "Response finished",
            priority,
          },
          () => isValid() && !isBlocked(sessionID),
        )
        if (isValid()) state.deliveredGeneration = generation
      } catch (error) {
        if (!isAbortError(error) && !token.cancelled && !disposed) {
          logFailure(formatError("ntfy completion notification", error))
        }
      } finally {
        finishToken(token)
        if (state.completion === attempt) state.completion = undefined
      }
    }

    attempt.promise = run()
    return attempt.promise
  }

  const requestAction = (kind: RequestKind) =>
    kind === "question" ? "ntfy question notification" : "ntfy permission notification"

  const runRequestNotification = async (entry: RequestEntry, token: AlertToken) => {
    const entries = entry.kind === "question" ? requests : permissions
    const action = requestAction(entry.kind)
    const isCurrent = () =>
      !disposed &&
      !token.cancelled &&
      !inactiveSessions.has(entry.sessionID) &&
      entries.get(entry.id) === entry &&
      entry.token === token
    try {
      if (entry.kind === "permission") {
        // Let OpenCode's auto-approve responder clear transient requests first.
        await wait(permissionDelayMs, token.controller.signal)
      }
      if (!isCurrent()) return

      const title = await resolveRequestTitle(entry.sessionID, token.controller.signal, action)
      if (!isCurrent()) return

      await publishSequence(
        token,
        {
          title: hideChatContent ? "OpenCode" : title,
          message: entry.kind === "question" ? "Question posed" : "Permissions request",
          priority,
        },
        isCurrent,
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
      sessionStates.get(sessionID)?.archived
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
    if (state) {
      state.generation++
      state.running = true
      state.deliveredGeneration = undefined
      cancelCompletionAttempt(state)
    }
    await Promise.all([
      dismissSessionRequests(sessionID),
      dismissCompletion(sessionID, true),
    ])
    if (releaseMetadata) sessionStates.delete(sessionID)
  }

  const handleSessionCreated = (data: Readonly<Record<string, unknown>> | undefined) => {
    if (typeof data?.sessionID !== "string") return
    inactiveSessions.delete(data.sessionID)
    const state = mergeSessionInfo(data.sessionID, data)
    state.archived = false
    state.completionBlocked = false
    state.watermark = undefined
    state.promptedAt = undefined
  }

  const nativeEventIsStale = (state: SessionState, watermark: EventWatermark) => {
    const previous = state.watermark
    const comparableSequence =
      watermark.aggregateID !== undefined &&
      previous?.aggregateID === watermark.aggregateID &&
      watermark.seq !== undefined &&
      previous.seq !== undefined
    if (comparableSequence) {
      if (watermark.seq! <= previous!.seq!) return true
    } else if (
      watermark.created !== undefined &&
      previous?.created !== undefined &&
      watermark.created < previous.created
    ) {
      return true
    }
    // A prompt has no durable sequence; its local timestamp is the only ordering signal.
    return (
      watermark.created !== undefined &&
      state.promptedAt !== undefined &&
      watermark.created < state.promptedAt
    )
  }

  const recordNativeEvent = (sessionID: string, watermark: EventWatermark) => {
    const state = ensureSessionState(sessionID)
    if (nativeEventIsStale(state, watermark)) return false
    state.watermark = watermark
    // Once a reliable native activity marker exists, use it instead of wall-clock time.
    state.promptedAt = undefined
    return true
  }

  const notePromptTime = (sessionID: string) => {
    const state = ensureSessionState(sessionID)
    state.promptedAt = Date.now()
  }

  const handleEvent = async (incoming: NotificationEvent) => {
    if (disposed) return
    const event = incoming
    if (!relevantEventTypes.has(event.type)) return
    const eventDirectory = event.location?.directory
    if (
      locationDirectory !== undefined &&
      typeof eventDirectory === "string" &&
      eventDirectory !== locationDirectory
    ) {
      return
    }

    try {
      switch (event.type) {
        case "session.created":
          handleSessionCreated(event.data)
          break
        case "session.renamed": {
          const state = ensureSessionState(event.data.sessionID)
          state.title = event.data.title
          break
        }
        case "session.moved": {
          ensureSessionState(event.data.sessionID).location = event.data.location.directory
          break
        }
        case "session.deleted": {
          await cancelSessionWork(event.data.sessionID, true)
          break
        }
        case "session.archived": {
          ensureSessionState(event.data.sessionID).archived = true
          await cancelSessionWork(event.data.sessionID, false)
          break
        }
        case "session.unarchived": {
          const sessionID = event.data.sessionID
          inactiveSessions.delete(sessionID)
          const state = ensureSessionState(sessionID)
          state.archived = false
          state.completionBlocked = false
          state.generation++
          state.running = false
          state.deliveredGeneration = undefined
          cancelCompletionAttempt(state)
          break
        }
        case "session.execution.started": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          await invalidateForActivity(sessionID, true)
          break
        }
        case "session.execution.succeeded": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          await notifyFinished(sessionID)
          break
        }
        case "session.execution.failed":
        case "session.execution.interrupted": {
          const sessionID = event.data.sessionID
          if (!recordNativeEvent(sessionID, eventWatermark(event))) break
          const state = ensureSessionState(sessionID)
          // A failed or interrupted execution must never surface as "Response finished".
          state.completionBlocked = true
          state.running = false
          state.generation++
          state.deliveredGeneration = undefined
          cancelCompletionAttempt(state)
          await dismissCompletion(sessionID)
          break
        }
        case "session.status": {
          const sessionID = event.data.sessionID
          const statusType = event.data.status.type
          if (statusType === "idle") {
            await notifyFinished(sessionID)
          } else if (statusType === "retry") {
            const state = ensureSessionState(sessionID)
            state.running = true
            state.generation++
            state.deliveredGeneration = undefined
            cancelCompletionAttempt(state)
          } else if (statusType === "busy") {
            await invalidateForActivity(sessionID, false)
          }
          break
        }
        case "session.idle": {
          await notifyFinished(event.data.sessionID)
          break
        }
        case "form.created": {
          await notifyRequest("question", event.data.form.id, event.data.form.sessionID)
          break
        }
        case "form.replied":
        case "form.cancelled": {
          await dismissRequest("question", event.data.id)
          break
        }
        case "permission.asked": {
          await notifyRequest("permission", event.data.id, event.data.sessionID)
          break
        }
        case "permission.replied": {
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

  const handlePrompt = async (sessionID: string) => {
    if (disposed || inactiveSessions.has(sessionID)) return
    try {
      notePromptTime(sessionID)
      await invalidateForActivity(sessionID, true)
    } catch (error) {
      if (!isAbortError(error) && !disposed) {
        logFailure(formatError("ntfy prompt handling", error))
      }
    }
  }

  const dispose = () => {
    if (disposePromise) return disposePromise
    disposed = true
    const sequences = new Set<string>(sequenceStates.keys())
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
      requests.clear()
      permissions.clear()
      requestIDsBySession.clear()
      permissionIDsBySession.clear()
      sessionStates.clear()
      inactiveSessions.clear()
      sequenceStates.clear()
      sequenceChains.clear()
      activeTokens.clear()
      liveControllers.clear()
    })()
    return disposePromise
  }

  return {
    handleEvent,
    handlePrompt,
    dispose,
  }
}

const subscriptionDelay = (attempt: number) =>
  Math.min(10_000, 250 * 2 ** Math.min(attempt, 16))

const subscriptionErrorMessage = (error: unknown) =>
  oneLine(error instanceof Error ? error.message : error, maximumFailureLength)

export async function setupNtfyRuntime(ctx: NtfySetupContext) {
  const runtime = await createNtfyRuntime(ctx)
  const controller = new AbortController()
  const tasks = new Set<Promise<void>>()
  let reconnectAttempt = 0
  let subscriptionFailures = 0

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

  const consume = async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
          types: relevantEventTypeList,
        })) {
          if (controller.signal.aborted) break
          if (subscriptionFailures > 0) {
            logFailure("event subscription recovered")
            subscriptionFailures = 0
            reconnectAttempt = 0
          }
          if (!relevantEventTypes.has(event.type)) continue
          track(
            (async () => {
              await runtime.handleEvent(event)
            })(),
          )
        }
      } catch (error) {
        if (controller.signal.aborted) break
        subscriptionFailures++
        logFailure(`event subscription failed: ${subscriptionErrorMessage(error)}`)
      }

      if (controller.signal.aborted) break

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

  const registeredHook = await ctx.session.hook("prompt", (event) => {
    // Never make OpenCode wait for ntfy I/O.
    track(
      (async () => {
        await runtime.handlePrompt(event.sessionID)
      })(),
    )
  })
  const hookRegistration =
    registeredHook && typeof registeredHook.dispose === "function" ? registeredHook : undefined

  const subscriptionTask = consume()
  track(subscriptionTask)

  let cleanupPromise: Promise<void> | undefined
  return () => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      controller.abort()
      if (hookRegistration) {
        try {
          await hookRegistration.dispose()
        } catch (error) {
          if (!isAbortError(error)) {
            logFailure(`prompt hook disposal failed: ${subscriptionErrorMessage(error)}`)
          }
        }
      }
      await runtime.dispose()
      await Promise.allSettled([...tasks, subscriptionTask])
    })()
    return cleanupPromise
  }
}

export default Plugin.define({
  id: "opencode-ntfy",
  async setup(ctx) {
    return setupNtfyRuntime(ctx)
  },
})
