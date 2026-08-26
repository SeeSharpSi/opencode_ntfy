import type { Plugin } from "@opencode-ai/plugin"

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

export const NtfyPlugin = (async ({ client, directory }, options) => {
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
  let disposed = false

  const check = async (response: Response, action: string) => {
    if (!response.ok) throw new Error(`${action} failed: ${response.status} ${await response.text()}`)
    return response
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
        console.error("[opencode-ntfy] notification dismissal failed", error)
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
    const response = await client.session.get({
      path: { id: sessionID },
      query: { directory },
      throwOnError: true,
    })
    return response.data as Session
  }

  const notifyQuestion = async (request: QuestionRequest) => {
    if (requests.has(request.id)) return
    requests.set(request.id, request.sessionID)

    try {
      const session = await getSession(request.sessionID)
      if (disposed || requests.get(request.id) !== request.sessionID) return
      await publishNotification(questionSequenceID(request.id), {
        title: hideChatContent ? "OpenCode" : session.title,
        message: "OpenCode has a question.",
        priority: 4,
        tags: ["question"],
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("[opencode-ntfy] question notification failed", error)
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
        message: "OpenCode needs permission.",
        priority: 4,
        tags: ["warning"],
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("[opencode-ntfy] permission notification failed", error)
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
      await publishNotification(completionSequenceID(sessionID), {
        title: hideChatContent ? "OpenCode" : session.title,
        message: "OpenCode response finished.",
        tags: ["heavy_check_mark"],
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("[opencode-ntfy] completion notification failed", error)
      }
    }
  }

  return {
    event: async ({ event }) => {
      // Question and permission events are absent from the legacy plugin SDK union.
      const input = event as
        | typeof event
        | { type: "question.asked"; properties: QuestionRequest }
        | {
            type: "question.replied" | "question.rejected"
            properties: { requestID: string }
          }
        | { type: "permission.asked"; properties: PermissionRequest }
        | {
            type: "permission.replied"
            properties: { sessionID: string; requestID: string }
          }
      if (input.type === "session.idle") {
        await notifyFinished(input.properties.sessionID)
      }
      if (input.type === "session.deleted") {
        invalidateCompletion(input.properties.info.id)
        await dismissSessionQuestions(input.properties.info.id)
        await dismissSessionPermissions(input.properties.info.id)
        if (!input.properties.info.parentID) {
          await dismissCompletion(input.properties.info.id, true)
        }
      }
      if (
        input.type === "session.updated" &&
        "archived" in input.properties.info.time &&
        input.properties.info.time.archived
      ) {
        invalidateCompletion(input.properties.info.id)
        await dismissSessionQuestions(input.properties.info.id)
        await dismissSessionPermissions(input.properties.info.id)
        if (!input.properties.info.parentID) {
          await dismissCompletion(input.properties.info.id, true)
        }
      }
      if (input.type === "question.asked") {
        await notifyQuestion(input.properties)
      }
      if (input.type === "question.replied" || input.type === "question.rejected") {
        await dismissQuestion(input.properties.requestID)
      }
      if (input.type === "permission.asked") {
        await notifyPermission(input.properties)
      }
      if (input.type === "permission.replied") {
        await dismissPermission(input.properties.requestID)
      }
    },
    "chat.message": async ({ sessionID }) => {
      invalidateCompletion(sessionID)
      await dismissCompletion(sessionID)
    },
    dispose: async () => {
      disposed = true
      await Promise.all(
        [...notificationOperations.keys()].map((sequenceID) =>
          dismissNotification(sequenceID, true),
        ),
      )
      requests.clear()
      permissionRequests.clear()
    },
  }
}) satisfies Plugin

export default NtfyPlugin
