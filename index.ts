import { Plugin } from "@opencode/plugin"
import type { OpenCodeEvent } from "@opencode/client"

type QuestionRequest = {
  id: string
  sessionID: string
}

type PermissionRequest = {
  id: string
  sessionID: string
}

const permissionNotificationDelay = 100

type Session = {
  title: string
  parentID?: string
}

type NtfyContext = {
  readonly options: Readonly<Record<string, unknown>>
  readonly session: {
    get(input: { sessionID: string }): Promise<unknown>
  }
}

export async function createNtfyRuntime(ctx: NtfyContext) {
  const options = ctx.options
  const environment = (
    globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }
  ).process?.env
  const pluginOption = (name: string) =>
    typeof options?.[name] === "string" ? options[name] : undefined
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
  const requests = new Map<string, string>()
  const permissionRequests = new Map<string, string>()
  const notificationOperations = new Map<string, Promise<boolean>>()
  const completionGenerations = new Map<string, number>()
  const rootSessions = new Set<string>()
  let disposed = false
  let lastFailure: string | undefined
  let suppressedFailures = 0
  const failureMessageLimit = 320

  const oneLine = (value: unknown, limit = 120) =>
    String(value).replace(/\s+/g, " ").trim().slice(0, limit)

  const failureHint = (status?: number) => {
    if (status === 401 || status === 403) {
      return "Hint: set NTFY_TOKEN or username/password; check topic permissions."
    }
    if (status === 429) return "Hint: ntfy rate limit reached; retry later."
    if (status === undefined) return "Hint: ntfy server unreachable; check network and server URL."
    return ""
  }

  const logFailure = (message: string) => {
    const normalized = oneLine(message, failureMessageLimit)
    if (normalized === lastFailure) {
      suppressedFailures++
      return
    }
    const suffix = suppressedFailures > 0 ? ` (${suppressedFailures} identical failure(s) suppressed)` : ""
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
      return oneLine(message, failureMessageLimit)
    }
    const networkFailure =
      error instanceof TypeError || (error instanceof Error && /fetch failed|network/i.test(message))
    return `${action} failed: ${oneLine(message)}${networkFailure ? ` ${failureHint()}` : ""}`
  }

  const check = async (response: Response, action: string) => {
    if (response.ok) {
      recordSuccess(action)
      return response
    }
    const body = await response.text()
    let errorText = oneLine(body)
    let code: number | undefined
    try {
      const parsed = JSON.parse(body) as { code?: unknown; error?: unknown }
      if (typeof parsed.error === "string") errorText = oneLine(parsed.error)
      if (typeof parsed.code === "number") code = parsed.code
    } catch {
      // Use bounded response text for non-JSON ntfy errors.
    }
    const codeText = code === undefined ? "" : `, ntfy code ${code}`
    const hint = failureHint(response.status)
    throw new Error(
      `${action} failed: HTTP ${response.status}${codeText}: ${errorText || "request failed"}${hint ? ` ${hint}` : ""}`,
    )
  }

  const topicUrl = (name: string, suffix = "") =>
    `${baseUrl}/${encodeURIComponent(name)}${suffix}`

  const completionSequenceID = (sessionID: string) => `opencode-${sessionID}`
  const questionSequenceID = (requestID: string) => `opencode-question-${requestID}`
  const permissionSequenceID = (requestID: string) => `opencode-permission-${requestID}`

  const publish = async (message: Record<string, unknown>) => {
    await check(
      await fetch(`${baseUrl}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ topic, ...message }),
      }),
      "ntfy publish",
    )
  }

  const publishNotification = (sequenceID: string, message: Record<string, unknown>) => {
    const previous = notificationOperations.get(sequenceID) ?? Promise.resolve(false)
    const published = previous.then(async () => {
      if (disposed) throw new DOMException("Plugin disposed", "AbortError")
      await publish({ ...message, sequence_id: sequenceID })
    })
    const state = published.then(
      () => true,
      () => previous,
    )
    notificationOperations.set(sequenceID, state)
    void state.then((active) => {
      if (!active && notificationOperations.get(sequenceID) === state) {
        notificationOperations.delete(sequenceID)
      }
    })
    return published
  }

  const dismissNotification = async (sequenceID: string, force = false) => {
    const previous = notificationOperations.get(sequenceID)
    if (!previous && !force) return
    const forceUnknownNotification = force && !previous

    const cleared = (previous ?? Promise.resolve(false)).then(async (active) => {
      if (!active && !forceUnknownNotification) return false
      try {
        await check(
          await fetch(topicUrl(topic, `/${encodeURIComponent(sequenceID)}/clear`), {
            method: "PUT",
            headers: authHeaders,
          }),
          "ntfy notification clear",
        )
        return false
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          logFailure(formatError("ntfy notification dismissal", error))
        }
        return active || forceUnknownNotification
      }
    })
    notificationOperations.set(sequenceID, cleared)
    const active = await cleared
    if (!active && notificationOperations.get(sequenceID) === cleared) {
      notificationOperations.delete(sequenceID)
    }
  }

  const invalidateCompletion = (sessionID: string) => {
    completionGenerations.set(sessionID, (completionGenerations.get(sessionID) ?? 0) + 1)
  }

  const dismissCompletion = async (sessionID: string, force = false) => {
    await dismissNotification(completionSequenceID(sessionID), force)
  }

  const getSession = async (sessionID: string) => {
    return (await ctx.session.get({ sessionID })) as Session
  }

  const notifyQuestion = async (request: QuestionRequest) => {
    if (requests.has(request.id)) return
    requests.set(request.id, request.sessionID)

    try {
      const session = await getSession(request.sessionID)
      if (disposed || requests.get(request.id) !== request.sessionID) return
      await publishNotification(questionSequenceID(request.id), {
        title: hideChatContent ? "OpenCode" : session.title,
        message: "Question posed",
        priority: 4,
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        logFailure(formatError("ntfy question notification", error))
      }
    }
  }

  const dismissQuestion = async (requestID: string) => {
    if (!requests.delete(requestID)) return
    await dismissNotification(questionSequenceID(requestID))
  }

  const dismissSessionQuestions = async (sessionID: string) => {
    await Promise.all(
      [...requests]
        .filter(([, requestSessionID]) => requestSessionID === sessionID)
        .map(([requestID]) => dismissQuestion(requestID)),
    )
  }

  const notifyPermission = async (request: PermissionRequest) => {
    if (permissionRequests.has(request.id)) return
    permissionRequests.set(request.id, request.sessionID)

    try {
      // Let OpenCode's auto-approve responder clear transient requests first.
      await new Promise<void>((resolve) => setTimeout(resolve, permissionNotificationDelay))
      if (disposed || permissionRequests.get(request.id) !== request.sessionID) return
      const session = await getSession(request.sessionID)
      if (disposed || permissionRequests.get(request.id) !== request.sessionID) return
      await publishNotification(permissionSequenceID(request.id), {
        title: hideChatContent ? "OpenCode" : session.title,
        message: "Permissions request",
        priority: 4,
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        logFailure(formatError("ntfy permission notification", error))
      }
    }
  }

  const dismissPermission = async (requestID: string) => {
    if (!permissionRequests.delete(requestID)) return
    await dismissNotification(permissionSequenceID(requestID))
  }

  const dismissSessionPermissions = async (sessionID: string) => {
    await Promise.all(
      [...permissionRequests]
        .filter(([, requestSessionID]) => requestSessionID === sessionID)
        .map(([requestID]) => dismissPermission(requestID)),
    )
  }

  const notifyFinished = async (sessionID: string) => {
    const generation = completionGenerations.get(sessionID) ?? 0
    if ([...requests.values()].includes(sessionID)) return
    if ([...permissionRequests.values()].includes(sessionID)) {
      await new Promise<void>((resolve) => setTimeout(resolve, permissionNotificationDelay))
      if (
        [...requests.values()].includes(sessionID) ||
        [...permissionRequests.values()].includes(sessionID)
      ) {
        return
      }
    }
    // Event hooks overlap; reject idle work invalidated by a newer prompt or session close.
    try {
      const session = await getSession(sessionID)
      if (
        session.parentID ||
        disposed ||
        generation !== (completionGenerations.get(sessionID) ?? 0)
      ) {
        return
      }
      rootSessions.add(sessionID)
      await publishNotification(completionSequenceID(sessionID), {
        title: hideChatContent ? "OpenCode" : session.title,
        message: "Response finished",
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        logFailure(formatError("ntfy completion notification", error))
      }
    }
  }

  const handleEvent = async (event: OpenCodeEvent) => {
    if (event.type === "session.idle") {
      await notifyFinished(event.data.sessionID)
    }
    if (event.type === "session.deleted") {
      invalidateCompletion(event.data.sessionID)
      await dismissSessionQuestions(event.data.sessionID)
      await dismissSessionPermissions(event.data.sessionID)
      if (rootSessions.delete(event.data.sessionID)) {
        await dismissCompletion(event.data.sessionID, true)
      }
    }
    if (event.type === "form.created") {
      await notifyQuestion(event.data.form)
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      await dismissQuestion(event.data.id)
    }
    if (event.type === "permission.asked") {
      await notifyPermission(event.data)
    }
    if (event.type === "permission.replied") {
      await dismissPermission(event.data.requestID)
    }
  }

  const handlePrompt = async (sessionID: string) => {
    invalidateCompletion(sessionID)
    await dismissCompletion(sessionID)
  }

  const dispose = async () => {
      disposed = true
      await Promise.all(
        [...notificationOperations.keys()].map((sequenceID) =>
          dismissNotification(sequenceID, true),
        ),
      )
      requests.clear()
      permissionRequests.clear()
      rootSessions.clear()
  }

  return {
    handleEvent,
    handlePrompt,
    dispose,
  }
}

export default Plugin.define({
  id: "opencode-ntfy",
  async setup(ctx) {
    const runtime = await createNtfyRuntime(ctx)
    const controller = new AbortController()
    const tasks = new Set<Promise<void>>()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const task = runtime.handleEvent(event)
          tasks.add(task)
          void task.finally(() => tasks.delete(task))
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error(`[opencode-ntfy] event subscription failed: ${String(error)}`)
        }
      }
    })()

    await ctx.session.hook("prompt", async (event) => {
      await runtime.handlePrompt(event.sessionID)
    })

    return async () => {
      controller.abort()
      await Promise.all([...tasks])
      await runtime.dispose()
    }
  },
})
