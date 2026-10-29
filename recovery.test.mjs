import assert from "node:assert/strict"
import test from "node:test"

import NtfyPlugin, { createNtfyRuntime, setupNtfyRuntime } from "./index.ts"

const environmentNames = [
  "NTFY_TOPIC",
  "NTFY_SERVER",
  "NTFY_URL",
  "NTFY_TOKEN",
  "NTFY_USERNAME",
  "NTFY_PASSWORD",
  "NTFY_ALLOW_INSECURE_HTTP",
  "NTFY_HIDE_CHAT_CONTENT",
  "NTFY_REQUEST_TIMEOUT_MS",
  "NTFY_RETRY_ATTEMPTS",
  "NTFY_RETRY_DELAY_MS",
  "NTFY_PERMISSION_DELAY_MS",
  "NTFY_PRIORITY",
]
const savedEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]))

test.before(() => {
  for (const name of environmentNames) delete process.env[name]
})

test.after(() => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const baseOptions = {
  topic: "recovery-topic",
  server: "https://ntfy.example.com",
  requestTimeoutMs: 500,
  retryAttempts: 1,
  retryDelayMs: 5,
  permissionDelayMs: 0,
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const withDeadline = (promise, milliseconds, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${milliseconds}ms`)),
      milliseconds,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

const waitFor = async (label, predicate, milliseconds = 2000) => {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error(`${label} was not satisfied within ${milliseconds}ms`)
}

const waitForAbort = (signal) =>
  new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener("abort", () => resolve(), { once: true })
  })

const useFetch = (handler) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = originalFetch
  }
}

const useSilentConsoleError = () => {
  const originalConsoleError = console.error
  const calls = []
  console.error = (...args) => calls.push(args)
  return {
    calls,
    restore: () => {
      console.error = originalConsoleError
    },
  }
}

const useSilentConsole = () => {
  const originalError = console.error
  const originalWarn = console.warn
  const originalLog = console.log
  const calls = []
  const capture = (...args) => calls.push(args)
  console.error = capture
  console.warn = capture
  console.log = capture
  const describe = (value) => {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return {
    calls,
    text: () => calls.map((args) => args.map(describe).join(" ")).join("\n"),
    restore: () => {
      console.error = originalError
      console.warn = originalWarn
      console.log = originalLog
    },
  }
}

const disposeQuietly = async (cleanup) => {
  try {
    await withDeadline(Promise.resolve().then(cleanup), 1000, "cleanup")
  } catch {
    // Surface the real assertion failure instead of an unrelated cleanup timeout.
  }
}

const clearSequenceID = (url) => {
  const parts = new URL(String(url)).pathname.split("/").filter(Boolean)
  const encoded = parts[parts.length - 2]
  return encoded === undefined ? undefined : decodeURIComponent(encoded)
}

const createFetchMock = ({ onPost, onClear } = {}) => {
  const posts = []
  const clears = []
  const fetch = async (url, init = {}) => {
    const target = String(url)
    const method = init.method ?? "GET"
    if (method === "POST") {
      const request = { url: target, init, body: JSON.parse(init.body) }
      posts.push(request)
      const response = onPost ? await onPost(request, posts.length) : undefined
      return response ?? new Response(null, { status: 200 })
    }
    if (method === "PUT" && target.endsWith("/clear")) {
      const request = {
        url: target,
        init,
        sequenceID: clearSequenceID(target),
        topic: decodeURIComponent(new URL(target).pathname.split("/").filter(Boolean)[0] ?? ""),
      }
      clears.push(request)
      const response = onClear ? await onClear(request, clears.length) : undefined
      return response ?? new Response(null, { status: 200 })
    }
    throw new Error(`unexpected request: ${method} ${target}`)
  }
  return { fetch, posts, clears }
}

const createStorage = ({ maxPageSize } = {}) => {
  const map = new Map()
  const clone = (value) => (value === undefined ? undefined : structuredClone(value))
  const storage = {
    async get(key) {
      return clone(map.get(key))
    },
    async set(key, value) {
      map.set(key, clone(value))
    },
    async remove(key) {
      map.delete(key)
    },
    async scan(options = {}) {
      const prefix = typeof options.prefix === "string" ? options.prefix : ""
      const after = typeof options.after === "string" ? options.after : undefined
      const requestedLimit =
        Number.isInteger(options.limit) && options.limit > 0 ? options.limit : Number.MAX_SAFE_INTEGER
      const limit =
        Number.isInteger(maxPageSize) && maxPageSize > 0
          ? Math.min(requestedLimit, maxPageSize)
          : requestedLimit
      const keys = [...map.keys()]
        .filter((key) => key.startsWith(prefix))
        .filter((key) => after === undefined || key > after)
        .sort()
      const selected = keys.slice(0, limit)
      return {
        entries: selected.map((key) => ({ key, value: clone(map.get(key)) })),
        ...(selected.length < keys.length ? { next: selected[selected.length - 1] } : {}),
      }
    },
    has: (key) => map.has(key),
    keys: () => [...map.keys()],
    text: () => JSON.stringify([...map.entries()]),
    size: () => map.size,
  }
  return storage
}

const makeSessionInfo = (id, overrides = {}) => ({
  id,
  projectID: "project-id",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title: `Session ${id}`,
  location: { directory: "/tmp/recovery-workspace", workspaceID: "workspace-recovery" },
  ...overrides,
})

const executionStartedEvent = (id, created = 100, seq = 1) => ({
  id: `execution-started-${id}-${seq}`,
  created,
  type: "session.execution.started",
  durable: { aggregateID: id, seq, version: 1 },
  data: { sessionID: id },
})

const executionSucceededEvent = (id) => ({
  type: "session.execution.succeeded",
  data: { sessionID: id },
})

const permissionAskedEvent = (id, sessionID) => ({
  type: "permission.asked",
  data: {
    id,
    sessionID,
    action: "read",
    resources: ["/tmp/example"],
  },
})

const permissionRecord = (id, sessionID) => ({
  id,
  sessionID,
  action: "read",
  resources: ["/tmp/example"],
})

const questionEvent = (id, sessionID) => ({
  type: "form.created",
  data: {
    form: {
      id,
      sessionID,
      title: "Question",
      fields: [],
    },
  },
})

const createContext = ({
  storage = createStorage(),
  sessions = [],
  pendingPermissions = [],
  options = {},
  location = "/tmp/recovery-workspace",
  workspaceID = "workspace-recovery",
  hookFailureAt,
  subscribe,
  listSessions,
  listPermissions,
  getSession,
  getPermission,
} = {}) => {
  const registrations = []
  const subscriptions = []
  const sessionByID = new Map(sessions.map((info) => [info.id, info]))
  let hookCount = 0

  const register = async (domain, name, callback) => {
    hookCount++
    if (hookFailureAt === hookCount) {
      throw new Error(`hook registration ${hookCount} failed`)
    }
    const registration = { domain, name, callback, disposed: 0 }
    registrations.push(registration)
    return {
      dispose: async () => {
        registration.disposed++
      },
    }
  }

  const ctx = {
    options: { ...baseOptions, ...options },
    location: { directory: location, workspaceID },
    storage,
    session: {
      list: async (input = {}, requestOptions) => {
        if (listSessions) return listSessions(input, requestOptions)
        return { data: sessions }
      },
      get: async ({ sessionID }, requestOptions) => {
        if (getSession) return getSession({ sessionID }, requestOptions)
        const info = sessionByID.get(sessionID)
        if (info) return info
        return makeSessionInfo(sessionID, {
          location: { directory: location, workspaceID },
        })
      },
      hook: (name, callback) => register("session", name, callback),
    },
    permission: {
      list: async (input = {}, requestOptions) => {
        if (listPermissions) return listPermissions(input, requestOptions)
        return pendingPermissions.filter(
          (request) => input.sessionID === undefined || request.sessionID === input.sessionID,
        )
      },
      get: async ({ sessionID, requestID }, requestOptions) => {
        if (getPermission) return getPermission({ sessionID, requestID }, requestOptions)
        const found = pendingPermissions.find(
          (request) => request.id === requestID && request.sessionID === sessionID,
        )
        if (!found) throw new Error(`permission ${requestID} is not pending`)
        return found
      },
      hook: (name, callback) => register("permission", name, callback),
    },
    event: {
      subscribe: (requestOptions = {}) => {
        subscriptions.push(requestOptions)
        if (subscribe) return subscribe(subscriptions.length, requestOptions)
        return (async function* () {
          await waitForAbort(requestOptions.signal)
        })()
      },
    },
  }

  return {
    ctx,
    storage,
    sessions,
    pendingPermissions,
    registrations,
    subscriptions,
    findRegistration: (domain, name) =>
      registrations.find(
        (registration) => registration.domain === domain && registration.name === name,
      ),
  }
}

const publishCompletion = async (runtime, sessionID) => {
  await runtime.handleEvent(executionSucceededEvent(sessionID))
}

test(
  "possible-active notification is durable before the POST and removed after a successful clear",
  { timeout: 5000 },
  async () => {
    const storage = createStorage()
    const token = "storage-secret-token"
    const title = "Storage Secret Session Title"
    const sessionID = "durable-session"
    const info = makeSessionInfo(sessionID, {
      title,
      time: { created: 1, updated: 2 },
    })
    const publishStarted = deferred()
    const releasePublish = deferred()
    const mock = createFetchMock({
      onPost: async () => {
        publishStarted.resolve()
        await releasePublish.promise
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const { ctx } = createContext({
      storage,
      sessions: [info],
      options: { token, hideChatContent: false },
    })
    const runtime = await createNtfyRuntime(ctx)

    try {
      const handling = publishCompletion(runtime, sessionID)
      await withDeadline(publishStarted.promise, 1000, "POST start")
      const request = mock.posts[0]
      const sequenceID = request?.body?.sequence_id
      assert.equal(typeof sequenceID, "string", "expected an ntfy sequence id")
      assert.ok(
        storage.text().includes(sequenceID),
        "possible-active record must exist while the POST is still in flight",
      )
      assert.equal(storage.text().includes(token), false, "auth token must not be persisted")
      assert.equal(storage.text().includes(title), false, "chat title must not be persisted")

      releasePublish.resolve()
      await withDeadline(handling, 1000, "completion publish")
      assert.equal(mock.posts.length, 1)
      assert.equal(storage.text().includes(sequenceID), true)

      await withDeadline(runtime.handlePrompt(sessionID), 1000, "notification dismissal")
      assert.ok(
        mock.clears.some((request) => request.sequenceID === sequenceID),
        "expected a clear request for the published notification",
      )
      assert.equal(
        storage.text().includes(sequenceID),
        false,
        "durable record must disappear after a successful clear",
      )
    } finally {
      releasePublish.resolve()
      await disposeQuietly(() => runtime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "failed clear retains the durable record and a later runtime retries it",
  { timeout: 5000 },
  async () => {
    const storage = createStorage()
    const sessionID = "clear-failure-session"
    const info = makeSessionInfo(sessionID, {
      time: { created: 1, updated: 2 },
    })
    let clearAttempts = 0
    const mock = createFetchMock({
      onClear: async () => {
        clearAttempts++
        return new Response(null, { status: clearAttempts === 1 ? 500 : 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const first = createContext({
      storage,
      sessions: [info],
      options: { hideChatContent: true },
    })
    const runtime = await createNtfyRuntime(first.ctx)
    let cleanup

    try {
      await publishCompletion(runtime, sessionID)
      assert.equal(mock.posts.length, 1)
      const sequenceID = mock.posts[0].body.sequence_id
      await withDeadline(runtime.handlePrompt(sessionID), 1000, "failed dismissal")
      assert.equal(clearAttempts, 1)
      assert.equal(
        storage.text().includes(sequenceID),
        true,
        "failed clear must leave the record for a later retry",
      )

      const second = createContext({ storage, sessions: [], options: { hideChatContent: true } })
      cleanup = await setupNtfyRuntime(second.ctx)
      await waitFor(
        "retry of the durable clear",
        () => clearAttempts >= 2,
        2000,
      )
      await waitFor(
        "durable record removal after the retry",
        () => !storage.text().includes(sequenceID),
        1000,
      )
    } finally {
      if (cleanup) await disposeQuietly(cleanup)
      await disposeQuietly(() => runtime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "storage write rejection prevents an untracked remote notification and does not log secrets",
  { timeout: 5000 },
  async () => {
    const baseStorage = createStorage()
    let setAttempts = 0
    const storage = {
      ...baseStorage,
      async set(_key, _value) {
        setAttempts++
        throw new Error("storage write rejected")
      },
    }
    const token = "log-secret-token"
    const title = "Log Secret Session Title"
    const sessionID = "storage-rejection-session"
    const info = makeSessionInfo(sessionID, {
      title,
      outcome: "succeeded",
      time: { created: 1, updated: 1 },
    })
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsole()
    const harness = createContext({
      storage,
      sessions: [info],
      options: { token, hideChatContent: false },
    })
    const runtime = await createNtfyRuntime(harness.ctx)

    try {
      await withDeadline(
        runtime.handleEvent(questionEvent("untracked-question", sessionID)),
        2000,
        "storage rejection handling",
      )
      await delay(50)
      assert.ok(setAttempts > 0, "the runtime must attempt to persist before publishing")
      assert.equal(
        mock.posts.length,
        0,
        "a notification that could not be tracked must not be sent",
      )
      const logs = silent.text()
      assert.equal(logs.includes(token), false, "auth token must not appear in logs")
      assert.equal(logs.includes(title), false, "chat title must not appear in logs")
    } finally {
      await disposeQuietly(() => runtime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "a new runtime clears stale durable notifications from a process that was never disposed",
  { timeout: 5000 },
  async () => {
    const storage = createStorage()
    const sessionID = "restart-session"
    const info = makeSessionInfo(sessionID, {
      time: { created: 1, updated: 2 },
    })
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const first = createContext({
      storage,
      sessions: [info],
      options: { hideChatContent: true },
    })
    const runtime = await createNtfyRuntime(first.ctx)
    let cleanup

    try {
      await publishCompletion(runtime, sessionID)
      const sequenceID = mock.posts[0].body.sequence_id
      assert.equal(storage.text().includes(sequenceID), true)

      const second = createContext({
        storage,
        sessions: [],
        options: { hideChatContent: true },
      })
      cleanup = await setupNtfyRuntime(second.ctx)
      await waitFor(
        "startup recovery clear",
        () => mock.clears.some((request) => request.sequenceID === sequenceID),
        2000,
      )
      await waitFor(
        "startup recovery record removal",
        () => !storage.text().includes(sequenceID),
        1000,
      )
    } finally {
      if (cleanup) await disposeQuietly(cleanup)
      await disposeQuietly(() => runtime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "startup recovery isolates durable notifications by server, topic, and workspace",
  { timeout: 6000 },
  async () => {
    const storage = createStorage()
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const runtimes = []
    const sessionIDs = {
      server: "namespace-server-session",
      topic: "namespace-topic-session",
      workspace: "namespace-workspace-session",
      target: "namespace-target-session",
    }
    const seed = async ({ id, server, topic, location, workspaceID }) => {
      const info = makeSessionInfo(id, {
        location: { directory: location, workspaceID },
        time: { created: 1, updated: 2 },
      })
      const seeded = createContext({
        storage,
        sessions: [info],
        location,
        workspaceID,
        options: { server, topic, hideChatContent: true },
      })
      const runtime = await createNtfyRuntime(seeded.ctx)
      runtimes.push(runtime)
      const before = mock.posts.length
      await publishCompletion(runtime, id)
      const posts = mock.posts.slice(before)
      assert.equal(posts.length, 1, `expected one publication for ${id}`)
      return posts[0].body.sequence_id
    }

    let cleanup
    try {
      const serverSequence = await seed({
        id: sessionIDs.server,
        server: "https://other-ntfy.example.com",
        topic: "recovery-topic",
        location: "/tmp/recovery-workspace",
        workspaceID: "workspace-recovery",
      })
      const topicSequence = await seed({
        id: sessionIDs.topic,
        server: "https://ntfy.example.com",
        topic: "other-topic",
        location: "/tmp/recovery-workspace",
        workspaceID: "workspace-recovery",
      })
      const workspaceSequence = await seed({
        id: sessionIDs.workspace,
        server: "https://ntfy.example.com",
        topic: "recovery-topic",
        location: "/tmp/other-workspace",
        workspaceID: "workspace-other",
      })
      const targetSequence = await seed({
        id: sessionIDs.target,
        server: "https://ntfy.example.com",
        topic: "recovery-topic",
        location: "/tmp/recovery-workspace",
        workspaceID: "workspace-recovery",
      })

      const recovering = createContext({
        storage,
        sessions: [],
        location: "/tmp/recovery-workspace",
        workspaceID: "workspace-recovery",
        options: { server: "https://ntfy.example.com", topic: "recovery-topic", hideChatContent: true },
      })
      cleanup = await setupNtfyRuntime(recovering.ctx)
      await waitFor(
        "namespaced startup recovery clear",
        () => mock.clears.some((request) => request.sequenceID === targetSequence),
        2000,
      )
      await delay(150)
      const clearedSequences = mock.clears.map((request) => request.sequenceID)
      assert.equal(clearedSequences.includes(serverSequence), false)
      assert.equal(clearedSequences.includes(topicSequence), false)
      assert.equal(clearedSequences.includes(workspaceSequence), false)
      assert.equal(storage.text().includes(serverSequence), true)
      assert.equal(storage.text().includes(topicSequence), true)
      assert.equal(storage.text().includes(workspaceSequence), true)
    } finally {
      if (cleanup) await disposeQuietly(cleanup)
      for (const runtime of runtimes) await disposeQuietly(() => runtime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "startup recovery paginates storage scans and clears every durable notification",
  { timeout: 12000 },
  async () => {
    const storage = createStorage({ maxPageSize: 20 })
    const sessionID = "pagination-session"
    const info = makeSessionInfo(sessionID, {
      outcome: "succeeded",
      time: { created: 1, updated: 1 },
    })
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const first = createContext({
      storage,
      sessions: [info],
      options: { hideChatContent: true },
    })
    const runtime = await createNtfyRuntime(first.ctx)
    let cleanup

    try {
      const notificationCount = 105
      for (let index = 0; index < notificationCount; index++) {
        await withDeadline(
          runtime.handleEvent(questionEvent(`pagination-question-${index}`, sessionID)),
          1000,
          `question ${index} publication`,
        )
      }
      assert.equal(mock.posts.length, notificationCount)
      const sequences = mock.posts.map((request) => request.body.sequence_id)
      assert.equal(new Set(sequences).size, notificationCount)
      const seededStorage = storage.text()
      for (const sequenceID of sequences) {
        assert.equal(
          seededStorage.includes(sequenceID),
          true,
          "each published notification must leave a durable possibly-active record",
        )
      }

      const second = createContext({
        storage,
        sessions: [],
        options: { hideChatContent: true },
      })
      cleanup = await setupNtfyRuntime(second.ctx)
      await waitFor(
        "pagination-aware recovery clear of every notification",
        () => {
          const cleared = new Set(mock.clears.map((request) => request.sequenceID))
          return sequences.every((sequenceID) => cleared.has(sequenceID))
        },
        8000,
      )
      const cleared = new Set(mock.clears.map((request) => request.sequenceID))
      assert.equal(cleared.size, notificationCount)
    } finally {
      if (cleanup) await disposeQuietly(cleanup)
      await disposeQuietly(() => runtime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "reconnect snapshot recovers one missed completion and repeated reconciliation does not duplicate it",
  { timeout: 8000 },
  async () => {
    const storage = createStorage()
    const sessionID = "reconnect-session"
    const info = makeSessionInfo(sessionID, {
      outcome: undefined,
      time: { created: 10, updated: 100, idle: 100 },
    })
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    let subscriptionCalls = 0
    const reachedFourthStream = deferred()

    const harness = createContext({
      storage,
      sessions: [info],
      options: { hideChatContent: true },
      subscribe: (call, requestOptions) => {
        subscriptionCalls = Math.max(subscriptionCalls, call)
        return (async function* () {
          if (call === 1) {
            yield executionStartedEvent(sessionID, 150, 7)
            await delay(20)
            info.outcome = "succeeded"
            info.time = { created: 10, updated: 250, idle: 250 }
            return
          }
          if (call === 2) return
          if (call === 3) return
          if (call === 4) reachedFourthStream.resolve()
          await waitForAbort(requestOptions.signal)
        })()
      },
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await waitFor("recovered completion", () => mock.posts.length === 1, 3000)
      await withDeadline(reachedFourthStream.promise, 3000, "repeated reconciliation")
      await delay(150)
      assert.equal(mock.posts.length, 1, "reconciliation must not publish a duplicate completion")
      assert.ok(subscriptionCalls >= 4)
    } finally {
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "startup with an already-idle session does not publish a historic completion",
  { timeout: 4000 },
  async () => {
    const storage = createStorage()
    const info = makeSessionInfo("historic-idle-session", {
      outcome: "succeeded",
      time: { created: 10, updated: 500, idle: 500 },
    })
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const harness = createContext({
      storage,
      sessions: [info],
      options: { hideChatContent: true },
      subscribe: (_call, requestOptions) =>
        (async function* () {
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await delay(300)
      assert.equal(mock.posts.length, 0, "startup must not notify for pre-existing idle sessions")
    } finally {
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "permission notification waits for a pending check and skips an auto-answered request",
  { timeout: 4000 },
  async () => {
    const storage = createStorage()
    const sessionID = "permission-session"
    const info = makeSessionInfo(sessionID, {
      outcome: "succeeded",
      time: { created: 1, updated: 1 },
    })
    const pending = []
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const harness = createContext({
      storage,
      sessions: [info],
      pendingPermissions: pending,
      options: { hideChatContent: true },
    })
    const runtime = await createNtfyRuntime(harness.ctx)

    try {
      await withDeadline(
        runtime.handleEvent(permissionAskedEvent("auto-answered", sessionID)),
        1000,
        "auto-answered permission handling",
      )
      await delay(100)
      assert.equal(mock.posts.length, 0, "auto-answered permission must not notify")

      pending.push(permissionRecord("still-pending", sessionID))
      await withDeadline(
        runtime.handleEvent(permissionAskedEvent("still-pending", sessionID)),
        1000,
        "pending permission handling",
      )
      assert.equal(mock.posts.length, 1)
      assert.match(mock.posts[0].body.sequence_id, /still-pending/)
    } finally {
      await disposeQuietly(() => runtime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "restart removes a published permission whose request is no longer pending",
  { timeout: 5000 },
  async () => {
    const storage = createStorage()
    const sessionID = "stale-permission-session"
    const info = makeSessionInfo(sessionID, {
      outcome: "succeeded",
      time: { created: 1, updated: 1 },
    })
    const pending = [permissionRecord("stale-permission", sessionID)]
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const first = createContext({
      storage,
      sessions: [info],
      pendingPermissions: pending,
      options: { hideChatContent: true },
    })
    const runtime = await createNtfyRuntime(first.ctx)
    let cleanup

    try {
      await withDeadline(
        runtime.handleEvent(permissionAskedEvent("stale-permission", sessionID)),
        1000,
        "permission publish",
      )
      assert.equal(mock.posts.length, 1)
      const sequenceID = mock.posts[0].body.sequence_id

      pending.length = 0
      const second = createContext({
        storage,
        sessions: [],
        pendingPermissions: pending,
        options: { hideChatContent: true },
      })
      cleanup = await setupNtfyRuntime(second.ctx)
      await waitFor(
        "stale permission clear",
        () => mock.clears.some((request) => request.sequenceID === sequenceID),
        2000,
      )
      await waitFor(
        "stale permission record removal",
        () => !storage.text().includes(sequenceID),
        1000,
      )
    } finally {
      if (cleanup) await disposeQuietly(cleanup)
      await disposeQuietly(() => runtime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "same-runtime reconnect clears a published permission that disappeared while disconnected",
  { timeout: 6000 },
  async () => {
    const storage = createStorage()
    const sessionID = "reconnect-permission-session"
    const info = makeSessionInfo(sessionID, {
      outcome: "succeeded",
      time: { created: 1, updated: 1 },
    })
    const pending = [permissionRecord("reconnect-permission", sessionID)]
    const mock = createFetchMock()
    const published = deferred()
    const disconnected = deferred()
    const restoreFetch = useFetch(
      ((handler) => async (url, init = {}) => {
        const response = await handler(url, init)
        if (init.method === "POST") published.resolve()
        return response
      })(mock.fetch),
    )
    const silent = useSilentConsoleError()
    let subscriptionCalls = 0
    const harness = createContext({
      storage,
      sessions: [info],
      pendingPermissions: pending,
      options: { hideChatContent: true },
      subscribe: (call, requestOptions) => {
        subscriptionCalls = Math.max(subscriptionCalls, call)
        return (async function* () {
          if (call === 1) {
            yield permissionAskedEvent("reconnect-permission", sessionID)
            await withDeadline(published.promise, 1000, "permission publication")
            disconnected.resolve()
            return
          }
          await waitForAbort(requestOptions.signal)
        })()
      },
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await withDeadline(disconnected.promise, 2000, "permission disconnect")
      assert.equal(mock.posts.length, 1)
      const sequenceID = mock.posts[0].body.sequence_id
      assert.equal(storage.text().includes(sequenceID), true)

      pending.length = 0
      await waitFor(
        "same-runtime stale permission clear",
        () => mock.clears.some((request) => request.sequenceID === sequenceID),
        3000,
      )
      await waitFor(
        "same-runtime stale permission record removal",
        () => !storage.text().includes(sequenceID),
        2000,
      )
      assert.ok(subscriptionCalls >= 2, "the same runtime must have reconnected")
    } finally {
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "a delayed stale startup snapshot cannot overwrite live events or duplicate completion",
  { timeout: 10000 },
  async () => {
    const storage = createStorage()
    const sessionID = "stale-snapshot-session"
    const location = {
      directory: "/tmp/recovery-workspace",
      workspaceID: "workspace-recovery",
    }
    const staleInfo = makeSessionInfo(sessionID, {
      title: "Stale Snapshot Title",
      outcome: "failed",
      location,
      time: { created: 1, updated: 20, idle: 20 },
    })
    const currentInfo = makeSessionInfo(sessionID, {
      title: "Fresh Live Title",
      outcome: "succeeded",
      location,
      time: { created: 1, updated: 130, idle: 130 },
    })
    const firstSnapshotGate = deferred()
    const eventsBuffered = deferred()
    const closeFirstStream = deferred()
    const firstPublished = deferred()
    const secondPublished = deferred()
    const secondSnapshotStarted = deferred()
    let postsSeen = 0
    const mock = createFetchMock({
      onPost: async () => {
        postsSeen++
        if (postsSeen === 1) firstPublished.resolve()
        if (postsSeen === 2) secondPublished.resolve()
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    let listCalls = 0

    const durableSessionEvent = (type, seq, created, data) => ({
      id: `${type}-${seq}`,
      created,
      type,
      durable: { aggregateID: sessionID, seq, version: 1 },
      location,
      data,
    })
    const createdEvent = durableSessionEvent("session.created", 1, 100, {
      sessionID,
      projectID: "project-id",
      location,
      slug: sessionID,
      title: "Initial Live Title",
    })
    const renamedEvent = (title, seq, created) =>
      durableSessionEvent("session.renamed", seq, created, { sessionID, title })
    const startedEvent = (seq, created) =>
      durableSessionEvent("session.execution.started", seq, created, { sessionID })
    const succeededEvent = (seq, created) =>
      durableSessionEvent("session.execution.succeeded", seq, created, { sessionID })

    const harness = createContext({
      storage,
      sessions: [staleInfo],
      options: { hideChatContent: false },
      listSessions: async () => {
        listCalls++
        if (listCalls === 1) {
          await firstSnapshotGate.promise
          return { data: [staleInfo] }
        }
        if (listCalls === 2) secondSnapshotStarted.resolve()
        return { data: [currentInfo] }
      },
      subscribe: (call, requestOptions) =>
        (async function* () {
          if (call === 1) {
            yield createdEvent
            yield renamedEvent("Fresh Live Title", 2, 110)
            yield startedEvent(3, 120)
            yield succeededEvent(4, 130)
            eventsBuffered.resolve()
            await closeFirstStream.promise
            return
          }
          yield renamedEvent("Newest Live Title", 5, 200)
          yield startedEvent(6, 210)
          yield succeededEvent(7, 220)
          await secondPublished.promise
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const setupPromise = setupNtfyRuntime(harness.ctx)
    let cleanup

    try {
      await withDeadline(eventsBuffered.promise, 3000, "live events buffered behind snapshot")
      firstSnapshotGate.resolve()
      await withDeadline(firstPublished.promise, 3000, "first live completion")
      assert.equal(mock.posts.length, 1)
      assert.equal(mock.posts[0].body.title, "Fresh Live Title")

      closeFirstStream.resolve()
      cleanup = await withDeadline(setupPromise, 1000, "setup after stale snapshot release")
      await withDeadline(secondSnapshotStarted.promise, 3000, "post-snapshot reconnect")
      await withDeadline(secondPublished.promise, 3000, "later live completion")

      assert.equal(mock.posts.length, 2, "stale snapshot must not duplicate the first completion")
      assert.equal(mock.posts[1].body.title, "Newest Live Title")
    } finally {
      firstSnapshotGate.resolve()
      closeFirstStream.resolve()
      if (!cleanup) {
        try {
          cleanup = await withDeadline(setupPromise, 1000, "setup cleanup")
        } catch {
          // Preserve the original assertion failure.
        }
      }
      if (cleanup) await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "a transient permission lookup error preserves the alert and keeps completion blocked",
  { timeout: 10000 },
  async () => {
    const storage = createStorage()
    const sessionID = "unknown-permission-session"
    const permissionID = "unknown-permission"
    const info = makeSessionInfo(sessionID, {
      time: { created: 1, updated: 2 },
    })
    const pending = []
    const permissionPublished = deferred()
    const permissionCleared = deferred()
    const lookupErrorObserved = deferred()
    const absentSnapshotStarted = deferred()
    const releaseAbsentSnapshot = deferred()
    const disconnectFirstStream = deferred()
    const disconnectSecondStream = deferred()
    let listMode = "ok"
    let completionPosts = 0
    const mock = createFetchMock({
      onPost: async (request) => {
        if (request.body.sequence_id === `opencode-permission-${permissionID}`) {
          permissionPublished.resolve()
        } else {
          completionPosts++
        }
        return new Response(null, { status: 200 })
      },
      onClear: async (request) => {
        if (request.sequenceID === `opencode-permission-${permissionID}`) {
          permissionCleared.resolve()
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()

    const harness = createContext({
      storage,
      sessions: [info],
      pendingPermissions: pending,
      options: { hideChatContent: true },
      listPermissions: async () => {
        if (listMode === "error") {
          lookupErrorObserved.resolve()
          throw new Error("temporary permission lookup failure")
        }
        if (listMode === "absent") {
          absentSnapshotStarted.resolve()
          await releaseAbsentSnapshot.promise
          return []
        }
        return pending.slice()
      },
      subscribe: (call, requestOptions) =>
        (async function* () {
          if (call === 1) {
            pending.push(permissionRecord(permissionID, sessionID))
            yield permissionAskedEvent(permissionID, sessionID)
            await permissionPublished.promise
            await disconnectFirstStream.promise
            return
          }
          if (call === 2) {
            await disconnectSecondStream.promise
            return
          }
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await withDeadline(permissionPublished.promise, 3000, "permission publication")
      const sequenceID = `opencode-permission-${permissionID}`
      assert.equal(storage.text().includes(sequenceID), true)

      listMode = "error"
      info.outcome = "succeeded"
      info.time = { created: 1, updated: 250, idle: 250 }
      disconnectFirstStream.resolve()
      await withDeadline(lookupErrorObserved.promise, 3000, "transient permission lookup error")

      listMode = "absent"
      disconnectSecondStream.resolve()
      await withDeadline(absentSnapshotStarted.promise, 3000, "absent permission snapshot")

      assert.equal(
        mock.clears.some((request) => request.sequenceID === sequenceID),
        false,
        "an unknown permission state must not erase the published permission",
      )
      assert.equal(completionPosts, 0, "an unknown permission state must keep completion blocked")
      assert.equal(storage.text().includes(sequenceID), true)

      releaseAbsentSnapshot.resolve()
      await withDeadline(permissionCleared.promise, 3000, "clear after absent permission snapshot")
      await waitFor(
        "permission record removal after absent snapshot",
        () => !storage.text().includes(sequenceID),
        1000,
      )
    } finally {
      releaseAbsentSnapshot.resolve()
      disconnectFirstStream.resolve()
      disconnectSecondStream.resolve()
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

const makeGate = () => ({ started: deferred(), release: deferred() })

const runHungLookupCleanupScenario = async (kind) => {
  const storage = createStorage()
  const sessionID = `hung-${kind}-session`
  const permissionID = `hung-${kind}-permission`
  const info = makeSessionInfo(sessionID, {
    time: { created: 1, updated: 2 },
  })
  const pending = []
  const permissionPublished = deferred()
  const permissionCleared = deferred()
  const disconnectFirstStream = deferred()
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  let hang = false
  const never = () => new Promise(() => {})
  const mock = createFetchMock({
    onPost: async (request) => {
      if (request.body.sequence_id === `opencode-permission-${permissionID}`) {
        permissionPublished.resolve()
      }
      return new Response(null, { status: 200 })
    },
    onClear: async (request) => {
      if (request.sequenceID === `opencode-permission-${permissionID}`) {
        permissionCleared.resolve()
      }
      return new Response(null, { status: 200 })
    },
  })
  const restoreFetch = useFetch(mock.fetch)
  const silent = useSilentConsoleError()
  const harness = createContext({
    storage,
    sessions: [info],
    pendingPermissions: pending,
    options: {
      hideChatContent: true,
      requestTimeoutMs: 30,
      retryAttempts: 1,
      retryDelayMs: 0,
      permissionDelayMs: 0,
    },
    listSessions:
      kind === "session"
        ? async () => {
            if (hang) return never()
            return { data: [info] }
          }
        : undefined,
    listPermissions: async () => {
      if (hang) return never()
      return pending.slice()
    },
    subscribe: (call, requestOptions) =>
      (async function* () {
        if (call === 1) {
          pending.push(permissionRecord(permissionID, sessionID))
          yield permissionAskedEvent(permissionID, sessionID)
          await permissionPublished.promise
          await disconnectFirstStream.promise
          return
        }
        if (call === 2) {
          yield {
            type: "permission.replied",
            data: { sessionID, requestID: permissionID, reply: "once" },
          }
          await waitForAbort(requestOptions.signal)
          return
        }
        await waitForAbort(requestOptions.signal)
      })(),
  })
  let cleanup
  try {
    cleanup = await setupNtfyRuntime(harness.ctx)
    await withDeadline(permissionPublished.promise, 2000, `${kind} permission publication`)
    hang = true
    disconnectFirstStream.resolve()
    await withDeadline(permissionCleared.promise, 1500, `${kind} reply clears hung lookup`)
    assert.equal(unhandled.length, 0, `${kind} lookup must not reject unhandled`)

    const started = Date.now()
    await withDeadline(cleanup(), 500, `${kind} cleanup with hung lookup`)
    cleanup = undefined
    assert.ok(Date.now() - started < 500, `${kind} cleanup must finish within 500ms`)
    assert.equal(unhandled.length, 0, `${kind} cleanup must not reject unhandled`)
  } finally {
    disconnectFirstStream.resolve()
    if (cleanup) {
      try {
        await withDeadline(cleanup(), 500, `${kind} fallback cleanup`)
      } catch {
        // Preserve the original assertion failure.
      }
    }
    process.off("unhandledRejection", onUnhandled)
    silent.restore()
    restoreFetch()
  }
}

test(
  "a hung session list is bounded and does not prevent reply cancellation or cleanup",
  { timeout: 6000 },
  async () => {
    await runHungLookupCleanupScenario("session")
  },
)

test(
  "a hung permission list is bounded and does not prevent reply cancellation or cleanup",
  { timeout: 6000 },
  async () => {
    await runHungLookupCleanupScenario("permission")
  },
)

test(
  "buffered failed execution outranks an older successful reconnect snapshot",
  { timeout: 8000 },
  async () => {
    const storage = createStorage()
    const sessionID = "buffered-failure-session"
    const activeInfo = makeSessionInfo(sessionID, {
      title: "Active Session",
      time: { created: 1, updated: 2 },
    })
    const successInfo = makeSessionInfo(sessionID, {
      title: "Stale Successful Snapshot",
      outcome: "succeeded",
      time: { created: 1, updated: 150, idle: 150 },
    })
    const reconnectListStarted = deferred()
    const releaseReconnectSnapshot = deferred()
    const bufferedFailure = deferred()
    const disconnectFirstStream = deferred()
    const questionPublished = deferred()
    const completionPosts = []
    let listCalls = 0
    const mock = createFetchMock({
      onPost: async (request) => {
        if (request.body.message === "Response finished") completionPosts.push(request)
        if (request.body.message === "Question posed") questionPublished.resolve()
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const harness = createContext({
      storage,
      sessions: [activeInfo],
      options: { hideChatContent: true },
      listSessions: async () => {
        listCalls++
        if (listCalls === 1) return { data: [activeInfo] }
        if (listCalls === 2) {
          reconnectListStarted.resolve()
          await releaseReconnectSnapshot.promise
          return { data: [successInfo] }
        }
        return { data: [successInfo] }
      },
      subscribe: (call, requestOptions) =>
        (async function* () {
          if (call === 1) {
            await disconnectFirstStream.promise
            return
          }
          if (call === 2) {
            yield {
              id: "newer-failed-execution",
              created: 200,
              type: "session.execution.failed",
              durable: { aggregateID: sessionID, seq: 5, version: 1 },
              data: { sessionID },
            }
            yield {
              id: "drain-marker-question",
              created: 210,
              type: "form.created",
              durable: { aggregateID: sessionID, seq: 6, version: 1 },
              data: {
                form: { id: "drain-marker", sessionID, title: "Question", fields: [] },
              },
            }
            bufferedFailure.resolve()
            await waitForAbort(requestOptions.signal)
            return
          }
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await waitFor("active recovery state", () => storage.size() > 0, 1000)
      disconnectFirstStream.resolve()
      await withDeadline(reconnectListStarted.promise, 3000, "reconnect snapshot request")
      await withDeadline(bufferedFailure.promise, 3000, "failed event buffering")
      releaseReconnectSnapshot.resolve()
      await withDeadline(questionPublished.promise, 3000, "buffered event drain")
      assert.equal(
        completionPosts.length,
        0,
        "a newer buffered failure must prevent a stale snapshot completion POST",
      )
      assert.ok(mock.posts.some((request) => request.body.message === "Question posed"))
    } finally {
      releaseReconnectSnapshot.resolve()
      disconnectFirstStream.resolve()
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "a directory-filtered list omission verified by get preserves permission and active state",
  { timeout: 8000 },
  async () => {
    const storage = createStorage()
    const sessionID = "omitted-session"
    const permissionID = "omitted-permission"
    const sameScopeInfo = makeSessionInfo(sessionID, {
      location: { directory: "/tmp/recovery-workspace-alt", workspaceID: "workspace-recovery" },
      time: { created: 1, updated: 2 },
    })
    const pending = [permissionRecord(permissionID, sessionID)]
    const permissionPublished = deferred()
    const disconnectFirst = deferred()
    const disconnectSecond = deferred()
    const listGates = []
    const getGates = []
    let getMode = "same"
    const mock = createFetchMock({
      onPost: async (request) => {
        if (request.body.sequence_id === `opencode-permission-${permissionID}`) {
          permissionPublished.resolve()
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const harness = createContext({
      storage,
      sessions: [sameScopeInfo],
      pendingPermissions: pending,
      options: { hideChatContent: true },
      location: "/tmp/recovery-workspace",
      workspaceID: "workspace-recovery",
      listSessions: async () => {
        const gate = listGates.shift()
        if (gate) {
          gate.started.resolve()
          await gate.release.promise
        }
        return { data: [] }
      },
      getSession: async () => {
        const gate = getGates.shift()
        if (gate) {
          gate.started.resolve()
          await gate.release.promise
        }
        if (getMode === "same") return sameScopeInfo
        throw new Error("temporary session lookup failure")
      },
      subscribe: (call, requestOptions) =>
        (async function* () {
          if (call === 1) {
            yield {
              type: "session.execution.started",
              created: 10,
              durable: { aggregateID: sessionID, seq: 1, version: 1 },
              location: { directory: "/tmp/recovery-workspace-alt", workspaceID: "workspace-recovery" },
              data: { sessionID },
            }
            yield {
              type: "permission.asked",
              created: 20,
              durable: { aggregateID: sessionID, seq: 2, version: 1 },
              location: { directory: "/tmp/recovery-workspace-alt", workspaceID: "workspace-recovery" },
              data: {
                id: permissionID,
                sessionID,
                action: "read",
                resources: ["/tmp/example"],
              },
            }
            await permissionPublished.promise
            await disconnectFirst.promise
            return
          }
          if (call === 2) {
            await disconnectSecond.promise
            return
          }
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await withDeadline(permissionPublished.promise, 3000, "omitted permission publication")
      assert.ok(storage.size() >= 2, "permission outbox and active recovery state must exist")

      const list2 = makeGate()
      const list3 = makeGate()
      const get2 = makeGate()
      listGates.push(list2, list3)
      getGates.push(get2)
      disconnectFirst.resolve()
      await withDeadline(list2.started.promise, 3000, "first omission snapshot")
      list2.release.resolve()
      await withDeadline(get2.started.promise, 3000, "same-scope get verification")
      getMode = "same"
      get2.release.resolve()
      disconnectSecond.resolve()
      await withDeadline(list3.started.promise, 3000, "post-preserve reconciliation")
      list3.release.resolve()
      assert.equal(
        mock.clears.some((request) => request.sequenceID === `opencode-permission-${permissionID}`),
        false,
        "same-scope get must preserve the published permission",
      )
      assert.ok(storage.size() >= 2, "same-scope get must preserve active recovery state")
    } finally {
      for (const gate of listGates) gate.release.resolve()
      for (const gate of getGates) gate.release.resolve()
      disconnectFirst.resolve()
      disconnectSecond.resolve()
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "transient session get failure preserves state but a definite 404 clears it",
  { timeout: 8000 },
  async () => {
    const storage = createStorage()
    const sessionID = "transient-get-session"
    const permissionID = "transient-get-permission"
    const sameScopeInfo = makeSessionInfo(sessionID, {
      location: { directory: "/tmp/recovery-workspace-alt", workspaceID: "workspace-recovery" },
      time: { created: 1, updated: 2 },
    })
    const pending = [permissionRecord(permissionID, sessionID)]
    const permissionPublished = deferred()
    const permissionCleared = deferred()
    const disconnectFirst = deferred()
    const disconnectSecond = deferred()
    const disconnectThird = deferred()
    const idleGate = deferred()
    const idleSent = deferred()
    const completionPosts = []
    const listGates = []
    const getGates = []
    let getMode = "transient"
    const mock = createFetchMock({
      onPost: async (request) => {
        if (request.body.sequence_id === `opencode-permission-${permissionID}`) {
          permissionPublished.resolve()
        }
        if (request.body.message === "Response finished") completionPosts.push(request)
        return new Response(null, { status: 200 })
      },
      onClear: async (request) => {
        if (request.sequenceID === `opencode-permission-${permissionID}`) {
          permissionCleared.resolve()
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const harness = createContext({
      storage,
      sessions: [sameScopeInfo],
      pendingPermissions: pending,
      options: { hideChatContent: true },
      location: "/tmp/recovery-workspace",
      workspaceID: "workspace-recovery",
      listSessions: async () => {
        const gate = listGates.shift()
        if (gate) {
          gate.started.resolve()
          await gate.release.promise
        }
        return { data: [] }
      },
      getSession: async () => {
        const gate = getGates.shift()
        if (gate) {
          gate.started.resolve()
          await gate.release.promise
        }
        if (getMode === "same") return sameScopeInfo
        if (getMode === "notFound") {
          const error = new Error("session not found")
          error.status = 404
          throw error
        }
        throw new Error("temporary session lookup failure")
      },
      subscribe: (call, requestOptions) =>
        (async function* () {
          if (call === 1) {
            yield {
              type: "session.execution.started",
              created: 10,
              durable: { aggregateID: sessionID, seq: 1, version: 1 },
              location: { directory: "/tmp/recovery-workspace-alt", workspaceID: "workspace-recovery" },
              data: { sessionID },
            }
            yield {
              type: "permission.asked",
              created: 20,
              durable: { aggregateID: sessionID, seq: 2, version: 1 },
              location: { directory: "/tmp/recovery-workspace-alt", workspaceID: "workspace-recovery" },
              data: {
                id: permissionID,
                sessionID,
                action: "read",
                resources: ["/tmp/example"],
              },
            }
            await permissionPublished.promise
            await disconnectFirst.promise
            return
          }
          if (call === 2) {
            await disconnectSecond.promise
            return
          }
          if (call === 3) {
            await disconnectThird.promise
            return
          }
          if (call === 4) {
            await idleGate.promise
            yield { type: "session.idle", data: { sessionID } }
            yield {
              type: "session.status",
              data: { sessionID, status: { type: "idle" } },
            }
            idleSent.resolve()
            await waitForAbort(requestOptions.signal)
            return
          }
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await withDeadline(permissionPublished.promise, 3000, "transient permission publication")
      const list2 = makeGate()
      const list3 = makeGate()
      const get2 = makeGate()
      listGates.push(list2, list3)
      getGates.push(get2)
      disconnectFirst.resolve()
      await withDeadline(list2.started.promise, 3000, "transient first omission snapshot")
      list2.release.resolve()
      await withDeadline(get2.started.promise, 3000, "transient get verification")
      getMode = "transient"
      get2.release.resolve()
      disconnectSecond.resolve()
      await withDeadline(list3.started.promise, 3000, "post-transient reconciliation")
      list3.release.resolve()
      assert.equal(
        mock.clears.some((request) => request.sequenceID === `opencode-permission-${permissionID}`),
        false,
        "transient get failure must preserve the published permission",
      )
      assert.ok(storage.size() >= 2, "transient get failure must preserve active recovery state")

      const get3 = makeGate()
      getGates.push(get3)
      getMode = "notFound"
      disconnectThird.resolve()
      await withDeadline(get3.started.promise, 3000, "definite 404 get verification")
      get3.release.resolve()
      await withDeadline(permissionCleared.promise, 3000, "definite 404 clears permission")
      await waitFor(
        "definite 404 permission record removal",
        () => !storage.text().includes(`opencode-permission-${permissionID}`),
        1000,
      )

      idleGate.resolve()
      await withDeadline(idleSent.promise, 2000, "post-404 idle events")
      await delay(80)
      assert.equal(
        completionPosts.length,
        0,
        "a confirmed missing session must stay ineligible for non-durable idle completions",
      )
    } finally {
      for (const gate of listGates) gate.release.resolve()
      for (const gate of getGates) gate.release.resolve()
      disconnectFirst.resolve()
      disconnectSecond.resolve()
      disconnectThird.resolve()
      idleGate.resolve()
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "prompt hook records activity before a historic idle snapshot can be recovered",
  { timeout: 8000 },
  async () => {
    const storage = createStorage()
    const sessionID = "prompt-admission-session"
    const historicInfo = makeSessionInfo(sessionID, {
      outcome: "succeeded",
      time: { created: 10, updated: 500, idle: 500 },
    })
    const disconnectFirst = deferred()
    const disconnectSecond = deferred()
    const secondListStarted = deferred()
    const thirdListStarted = deferred()
    let listCalls = 0
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const harness = createContext({
      storage,
      sessions: [historicInfo],
      options: { hideChatContent: true },
      listSessions: async () => {
        listCalls++
        if (listCalls === 2) secondListStarted.resolve()
        if (listCalls === 3) thirdListStarted.resolve()
        return { data: [historicInfo] }
      },
      subscribe: (call, requestOptions) =>
        (async function* () {
          if (call === 1) {
            await disconnectFirst.promise
            return
          }
          if (call === 2) {
            await disconnectSecond.promise
            return
          }
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await waitFor(
        "prompt hook registration",
        () => harness.findRegistration("session", "prompt") !== undefined,
        1000,
      )
      const promptHook = harness.findRegistration("session", "prompt").callback
      await promptHook({ sessionID })
      assert.equal(mock.posts.length, 0)

      disconnectFirst.resolve()
      await withDeadline(secondListStarted.promise, 3000, "prompt reconnect snapshot")
      disconnectSecond.resolve()
      await withDeadline(thirdListStarted.promise, 3000, "post-reconnect reconciliation")
      assert.equal(
        mock.posts.length,
        0,
        "a prompt hook without start/busy events must not admit a historic idle completion",
      )
    } finally {
      disconnectFirst.resolve()
      disconnectSecond.resolve()
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "prompt before native admission invalidates a restarted active checkpoint across reconnect",
  { timeout: 10000 },
  async () => {
    const storage = createStorage()
    const sessionID = "prompt-restart-session"
    const location = {
      directory: "/tmp/recovery-workspace",
      workspaceID: "workspace-recovery",
    }
    const activeInfo = makeSessionInfo(sessionID, { location, time: { created: 1, updated: 2 } })
    const staleSuccessInfo = makeSessionInfo(sessionID, {
      location,
      outcome: "succeeded",
      time: { created: 1, updated: 500, idle: 500 },
    })
    const firstRuntime = await createNtfyRuntime(
      createContext({
        storage,
        sessions: [activeInfo],
        location: location.directory,
        workspaceID: location.workspaceID,
        options: { hideChatContent: true },
      }).ctx,
    )
    const firstListBlocked = deferred()
    const releaseFirstList = deferred()
    const secondListStarted = deferred()
    const thirdListStarted = deferred()
    const disconnectFirst = deferred()
    const disconnectSecond = deferred()
    const nativeGate = deferred()
    const nativeSent = deferred()
    const nativeCompletion = deferred()
    let listCalls = 0
    const mock = createFetchMock({
      onPost: async (request) => {
        if (request.body.message === "Response finished") nativeCompletion.resolve()
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const harness = createContext({
      storage,
      sessions: [staleSuccessInfo],
      location: location.directory,
      workspaceID: location.workspaceID,
      options: { hideChatContent: true },
      listSessions: async () => {
        listCalls++
        if (listCalls === 1) {
          firstListBlocked.resolve()
          await releaseFirstList.promise
          return { data: [staleSuccessInfo] }
        }
        if (listCalls === 2) secondListStarted.resolve()
        if (listCalls === 3) thirdListStarted.resolve()
        return { data: [staleSuccessInfo] }
      },
      subscribe: (call, requestOptions) =>
        (async function* () {
          if (call === 1) {
            await disconnectFirst.promise
            return
          }
          if (call === 2) {
            await disconnectSecond.promise
            return
          }
          if (call === 3) {
            await nativeGate.promise
            yield {
              type: "session.execution.started",
              created: 1000,
              durable: { aggregateID: sessionID, seq: 20, version: 1 },
              location,
              data: { sessionID },
            }
            yield {
              type: "session.execution.succeeded",
              created: 1010,
              durable: { aggregateID: sessionID, seq: 21, version: 1 },
              location,
              data: { sessionID },
            }
            nativeSent.resolve()
            await waitForAbort(requestOptions.signal)
            return
          }
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const setupPromise = setupNtfyRuntime(harness.ctx)
    let cleanup

    try {
      await withDeadline(
        firstRuntime.handleEvent({
          type: "session.execution.started",
          created: 10,
          durable: { aggregateID: sessionID, seq: 1, version: 1 },
          location,
          data: { sessionID },
        }),
        1000,
        "first runtime active checkpoint",
      )
      await waitFor("persisted active checkpoint", () => storage.size() > 0, 1000)

      await withDeadline(firstListBlocked.promise, 2000, "blocked restarted snapshot")
      await waitFor(
        "prompt hook registration",
        () => harness.findRegistration("session", "prompt") !== undefined,
        1000,
      )
      await harness.findRegistration("session", "prompt").callback({ sessionID })

      releaseFirstList.resolve()
      cleanup = await withDeadline(setupPromise, 1000, "restarted setup after snapshot release")
      disconnectFirst.resolve()
      await withDeadline(secondListStarted.promise, 3000, "first post-prompt reconnect")
      disconnectSecond.resolve()
      await withDeadline(thirdListStarted.promise, 3000, "second post-prompt reconnect")
      assert.equal(
        mock.posts.length,
        0,
        "a stale successful snapshot must not recover across prompt pre-admission reconnects",
      )

      nativeGate.resolve()
      await withDeadline(nativeSent.promise, 2000, "native new execution")
      await withDeadline(nativeCompletion.promise, 3000, "native completion after admission")
      assert.equal(mock.posts.length, 1)
    } finally {
      releaseFirstList.resolve()
      disconnectFirst.resolve()
      disconnectSecond.resolve()
      nativeGate.resolve()
      if (!cleanup) {
        try {
          cleanup = await withDeadline(setupPromise, 1000, "restarted setup cleanup")
        } catch {
          // Preserve the original assertion failure.
        }
      }
      if (cleanup) await disposeQuietly(cleanup)
      await disposeQuietly(() => firstRuntime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "a failed recovery completion POST retains its checkpoint and retries exactly once",
  { timeout: 10000 },
  async () => {
    const storage = createStorage()
    const sessionID = "recovery-post-failure-session"
    const info = makeSessionInfo(sessionID, {
      time: { created: 1, updated: 2 },
    })
    const firstAttempt = deferred()
    const secondAttempt = deferred()
    const disconnectFirst = deferred()
    const disconnectSecond = deferred()
    const thirdListStarted = deferred()
    let attempts = 0
    let listCalls = 0
    const mock = createFetchMock({
      onPost: async () => {
        attempts++
        if (attempts === 1) {
          firstAttempt.resolve()
          throw new TypeError("fetch failed")
        }
        secondAttempt.resolve()
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const harness = createContext({
      storage,
      sessions: [info],
      options: { hideChatContent: true },
      listSessions: async () => {
        listCalls++
        if (listCalls === 3) thirdListStarted.resolve()
        return { data: [info] }
      },
      subscribe: (call, requestOptions) =>
        (async function* () {
          if (call === 1) {
            yield {
              type: "session.execution.succeeded",
              created: 200,
              durable: { aggregateID: sessionID, seq: 2, version: 1 },
              data: { sessionID },
            }
            await firstAttempt.promise
            await disconnectFirst.promise
            return
          }
          if (call === 2) {
            await disconnectSecond.promise
            return
          }
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await withDeadline(firstAttempt.promise, 3000, "first completion attempt")
      assert.equal(mock.posts.length, 1)
      info.outcome = "succeeded"
      info.time = { created: 1, updated: 200, idle: 200 }

      disconnectFirst.resolve()
      await withDeadline(secondAttempt.promise, 4000, "recovered completion retry")
      assert.equal(mock.posts.length, 2)

      disconnectSecond.resolve()
      await withDeadline(thirdListStarted.promise, 3000, "post-recovery reconciliation")
      assert.equal(mock.posts.length, 2, "a successful recovery must not publish again")
    } finally {
      disconnectFirst.resolve()
      disconnectSecond.resolve()
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "an explicit foreign event directory does not inherit the cached workspace identity",
  { timeout: 4000 },
  async () => {
    const storage = createStorage()
    const sessionID = "foreign-directory-session"
    const cachedInfo = makeSessionInfo(sessionID, {
      location: { directory: "/tmp/recovery-workspace", workspaceID: "workspace-recovery" },
      time: { created: 1, updated: 2 },
    })
    const mock = createFetchMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const harness = createContext({
      storage,
      sessions: [cachedInfo],
      location: "/tmp/recovery-workspace",
      workspaceID: "workspace-recovery",
      options: { hideChatContent: true },
    })
    const runtime = await createNtfyRuntime(harness.ctx)

    try {
      await withDeadline(
        runtime.handleEvent({
          type: "session.created",
          created: 10,
          durable: { aggregateID: sessionID, seq: 1, version: 1 },
          location: { directory: "/tmp/recovery-workspace", workspaceID: "workspace-recovery" },
          data: {
            sessionID,
            projectID: "project-id",
            location: { directory: "/tmp/recovery-workspace", workspaceID: "workspace-recovery" },
            slug: sessionID,
            title: "Cached Session",
          },
        }),
        1000,
        "cached session creation",
      )
      await withDeadline(
        runtime.handleEvent({
          type: "form.created",
          created: 20,
          durable: { aggregateID: sessionID, seq: 2, version: 1 },
          location: { directory: "/tmp/foreign-workspace" },
          data: {
            form: { id: "foreign-question", sessionID, title: "Question", fields: [] },
          },
        }),
        1000,
        "foreign directory question",
      )
      assert.equal(
        mock.posts.length,
        0,
        "an explicit foreign directory must not inherit the cached workspace ID",
      )
    } finally {
      await disposeQuietly(() => runtime.dispose())
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "hook callbacks contain scheduler failures without throwing into OpenCode",
  { timeout: 5000 },
  async () => {
    const sessionID = "scheduler-failure-session"
    const harness = createContext({
      storage: createStorage(),
      sessions: [makeSessionInfo(sessionID)],
      options: { hideChatContent: true, permissionDelayMs: 10 },
    })
    const silent = useSilentConsoleError()
    const unhandled = []
    const onUnhandled = (reason) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    const originalSetTimeout = globalThis.setTimeout
    let cleanup

    const withFailingScheduler = async (callback) => {
      globalThis.setTimeout = () => {
        throw new Error("scheduler unavailable")
      }
      try {
        return await callback()
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    }

    try {
      cleanup = await setupNtfyRuntime(harness.ctx)
      await waitFor(
        "permission evaluate hook",
        () => harness.findRegistration("permission", "evaluate") !== undefined,
        1000,
      )
      await waitFor(
        "session retry hook",
        () => harness.findRegistration("session", "retry") !== undefined,
        1000,
      )
      await waitFor(
        "session prompt hook",
        () => harness.findRegistration("session", "prompt") !== undefined,
        1000,
      )

      const evaluate = harness.findRegistration("permission", "evaluate").callback
      const evaluation = {
        sessionID,
        action: "read",
        resources: ["/tmp/scheduler-example"],
        effect: "ask",
      }
      const evaluationSnapshot = structuredClone(evaluation)
      await withFailingScheduler(() => evaluate(evaluation))
      assert.deepEqual(
        evaluation,
        evaluationSnapshot,
        "evaluate callback must not change the decision when scheduling fails",
      )

      const retry = harness.findRegistration("session", "retry").callback
      const retryInput = {
        sessionID,
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
        error: { name: "ApiError", message: "rate limited" },
        attempt: 1,
        decision: { retry: true, delay: 500 },
      }
      const retrySnapshot = structuredClone(retryInput)
      await withFailingScheduler(() => retry(retryInput))
      assert.deepEqual(
        retryInput,
        retrySnapshot,
        "retry callback must not change the decision when scheduling fails",
      )

      const prompt = harness.findRegistration("session", "prompt").callback
      await withFailingScheduler(() => prompt({ sessionID }))
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(unhandled.length, 0, "hook callbacks must not create unhandled rejections")
      assert.ok(Array.isArray(silent.calls))
    } finally {
      globalThis.setTimeout = originalSetTimeout
      process.off("unhandledRejection", onUnhandled)
      if (cleanup) await disposeQuietly(cleanup)
      silent.restore()
    }
  },
)

test(
  "permission advisory work ignores allow evaluations and coalesces ask evaluations per session",
  { timeout: 6000 },
  async () => {
    const sessionID = "advisory-burst-session"
    const nativePermissionID = "native-authoritative-permission"
    const pending = []
    const nativeGate = deferred()
    const nativePublished = deferred()
    let listCalls = 0
    const mock = createFetchMock({
      onPost: async (request) => {
        if (request.body.sequence_id === `opencode-permission-${nativePermissionID}`) {
          nativePublished.resolve()
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const permissionDelayMs = 20
    const harness = createContext({
      storage: createStorage(),
      sessions: [],
      pendingPermissions: pending,
      options: { hideChatContent: true, permissionDelayMs },
      listPermissions: async () => {
        listCalls++
        return pending.slice()
      },
      subscribe: (_call, requestOptions) =>
        (async function* () {
          await nativeGate.promise
          yield permissionAskedEvent(nativePermissionID, sessionID)
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await waitFor(
        "permission evaluate hook",
        () => harness.findRegistration("permission", "evaluate") !== undefined,
        1000,
      )
      const evaluate = harness.findRegistration("permission", "evaluate").callback

      const allowEvaluations = []
      for (let index = 0; index < 30; index++) {
        const evaluation = {
          sessionID,
          action: "read",
          resources: [`/tmp/allow-${index}`],
          effect: "allow",
        }
        allowEvaluations.push({ evaluation, snapshot: structuredClone(evaluation) })
        evaluate(evaluation)
      }
      await delay(permissionDelayMs * 3)
      assert.equal(listCalls, 0, "allow evaluations must not schedule advisory permission checks")

      const beforeAsk = listCalls
      const askEvaluations = []
      for (let index = 0; index < 30; index++) {
        const evaluation = {
          sessionID,
          action: "read",
          resources: [`/tmp/ask-${index}`],
          effect: "ask",
        }
        askEvaluations.push({ evaluation, snapshot: structuredClone(evaluation) })
        evaluate(evaluation)
      }
      await waitFor(
        "coalesced ask advisory lookup",
        () => listCalls > beforeAsk,
        1000,
      )
      await delay(permissionDelayMs * 2)
      assert.equal(
        listCalls - beforeAsk,
        1,
        "ask evaluations in one grace interval must coalesce into one advisory lookup",
      )
      assert.equal(mock.posts.length, 0, "advisory lookups must not publish notifications")
      for (const { evaluation, snapshot } of [...allowEvaluations, ...askEvaluations]) {
        assert.deepEqual(evaluation, snapshot)
      }

      pending.push(permissionRecord(nativePermissionID, sessionID))
      nativeGate.resolve()
      await withDeadline(nativePublished.promise, 2000, "native authoritative permission")
      assert.equal(mock.posts.length, 1)
      assert.match(mock.posts[0].body.sequence_id, new RegExp(nativePermissionID))
    } finally {
      nativeGate.resolve()
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "default plugin rejects unsupported hosts before touching setup services",
  { timeout: 4000 },
  async () => {
    const touched = []
    const oldContext = {
      app: { version: "2.0.15" },
      options: { ...baseOptions },
      get session() {
        touched.push("session")
        return { get: async () => undefined, hook: async () => ({ dispose: async () => {} }) }
      },
      get storage() {
        touched.push("storage")
        return createStorage()
      },
      get permission() {
        touched.push("permission")
        return { hook: async () => ({ dispose: async () => {} }) }
      },
      get event() {
        touched.push("event")
        return { subscribe: async function* () {} }
      },
    }
    await assert.rejects(
      NtfyPlugin.setup(oldContext),
      /opencode-ntfy requires OpenCode 2\.2\.1/,
    )
    assert.equal(touched.includes("session"), false)
    assert.equal(touched.includes("storage"), false)

    const harness = createContext({
      storage: createStorage(),
      sessions: [],
      options: { hideChatContent: true },
    })
    harness.ctx.app = { version: "2.2.1" }
    const restoreFetch = useFetch(createFetchMock().fetch)
    const cleanup = await NtfyPlugin.setup(harness.ctx)
    try {
      assert.equal(typeof cleanup, "function")
    } finally {
      if (typeof cleanup === "function") await disposeQuietly(cleanup)
      restoreFetch()
    }
  },
)

const runAmbiguousPermissionRetryScenario = async (mode) => {
  const storage = createStorage()
  const sessionID = `ambiguous-permission-${mode}-session`
  const permissionID = `ambiguous-permission-${mode}`
  const sequenceID = `opencode-permission-${permissionID}`
  const pending = [permissionRecord(permissionID, sessionID)]
  const secondSetStarted = deferred()
  const releaseSecondSet = deferred()
  const clearSeen = deferred()
  let setCount = 0
  let permissionPosts = 0
  const controlledStorage = {
    ...storage,
    async set(key, value) {
      setCount++
      if (setCount === 2) {
        secondSetStarted.resolve()
        await releaseSecondSet.promise
        if (mode === "reject") throw new Error("second durable write rejected")
      }
      return storage.set(key, value)
    },
  }
  const mock = createFetchMock({
    onPost: async (request) => {
      if (request.body.sequence_id === sequenceID) {
        permissionPosts++
        if (permissionPosts === 1) throw new TypeError("fetch failed")
      }
      return new Response(null, { status: 200 })
    },
    onClear: async (request) => {
      if (request.sequenceID === sequenceID) clearSeen.resolve()
      return new Response(null, { status: 200 })
    },
  })
  const restoreFetch = useFetch(mock.fetch)
  const silent = useSilentConsoleError()
  const harness = createContext({
    storage: controlledStorage,
    sessions: [],
    pendingPermissions: pending,
    options: {
      hideChatContent: true,
      permissionDelayMs: 0,
      retryAttempts: 1,
      requestTimeoutMs: 200,
    },
  })
  const runtime = await createNtfyRuntime(harness.ctx)

  try {
    await withDeadline(
      runtime.handleEvent(permissionAskedEvent(permissionID, sessionID)),
      1000,
      `${mode} first permission POST`,
    )
    assert.equal(permissionPosts, 1)
    assert.equal(storage.text().includes(sequenceID), true)

    const retryPromise = runtime.handleEvent(permissionAskedEvent(permissionID, sessionID))
    await withDeadline(secondSetStarted.promise, 1000, `${mode} blocked second write`)
    assert.equal(setCount, 2)

    const replyPromise = runtime.handleEvent({
      type: "permission.replied",
      data: { sessionID, requestID: permissionID, reply: "once" },
    })
    await Promise.resolve()
    await Promise.resolve()
    releaseSecondSet.resolve()

    await withDeadline(retryPromise, 1000, `${mode} retry completion`)
    await withDeadline(replyPromise, 1000, `${mode} reply completion`)
    await withDeadline(clearSeen.promise, 1000, `${mode} possible-active clear`)
    assert.equal(permissionPosts, 1, "reply cancellation must prevent a second permission POST")
    assert.ok(
      mock.clears.some((request) => request.sequenceID === sequenceID),
      "the previous possibly-active alert must still be cleared",
    )
    await waitFor(
      "prior permission record removal",
      () => !storage.text().includes(sequenceID),
      1000,
    )
  } finally {
    releaseSecondSet.resolve()
    await disposeQuietly(() => runtime.dispose())
    silent.restore()
    restoreFetch()
  }
}

test(
  "a duplicate permission ask blocked on durable write cannot POST after reply cancellation",
  { timeout: 5000 },
  async () => {
    await runAmbiguousPermissionRetryScenario("release")
  },
)

test(
  "a rejected duplicate durable write preserves prior possible-active knowledge for clear",
  { timeout: 5000 },
  async () => {
    await runAmbiguousPermissionRetryScenario("reject")
  },
)

test(
  "evaluation and retry hooks are advisory and leave caller decisions unchanged",
  { timeout: 4000 },
  async () => {
    const harness = createContext({
      storage: createStorage(),
      sessions: [makeSessionInfo("hook-session")],
      options: { hideChatContent: true },
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)
    const silent = useSilentConsoleError()
    const restoreFetch = useFetch(createFetchMock().fetch)

    try {
      await waitFor(
        "permission evaluate hook",
        () => harness.findRegistration("permission", "evaluate") !== undefined,
        1000,
      )
      await waitFor(
        "session retry hook",
        () => harness.findRegistration("session", "retry") !== undefined,
        1000,
      )

      const evaluate = harness.findRegistration("permission", "evaluate").callback
      const evaluation = {
        sessionID: "hook-session",
        action: "read",
        resources: ["/tmp/example"],
        effect: "ask",
      }
      const evaluationSnapshot = structuredClone(evaluation)
      await evaluate(evaluation)
      assert.deepEqual(evaluation, evaluationSnapshot, "evaluation hook must not mutate the decision")

      const retry = harness.findRegistration("session", "retry").callback
      const retryInput = {
        sessionID: "hook-session",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
        error: { name: "ApiError", message: "rate limited" },
        attempt: 1,
        decision: { retry: true, delay: 750 },
      }
      const retrySnapshot = structuredClone(retryInput)
      await retry(retryInput)
      assert.deepEqual(retryInput, retrySnapshot, "retry hook must not mutate the retry decision")
    } finally {
      await disposeQuietly(cleanup)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "event subscription requests relevant types and excludes high-volume deltas",
  { timeout: 4000 },
  async () => {
    const harness = createContext({
      storage: createStorage(),
      sessions: [],
      options: { hideChatContent: true },
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    try {
      await waitFor("event subscription", () => harness.subscriptions.length > 0, 1000)
      const types = harness.subscriptions[0].types
      assert.ok(Array.isArray(types), "subscription must declare an explicit type list")
      const requested = new Set(types)
      for (const type of [
        "session.execution.started",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.idle",
        "session.status",
        "permission.asked",
        "permission.replied",
        "form.created",
        "form.replied",
        "form.cancelled",
      ]) {
        assert.equal(requested.has(type), true, `subscription must include ${type}`)
      }
      for (const type of [
        "session.text.delta",
        "session.reasoning.delta",
        "session.tool.input.delta",
        "session.compaction.delta",
        "session.step.streamed",
      ]) {
        assert.equal(requested.has(type), false, `subscription must exclude ${type}`)
      }
    } finally {
      await disposeQuietly(cleanup)
    }
  },
)

test(
  "cleanup disposes every registered hook exactly once",
  { timeout: 4000 },
  async () => {
    const harness = createContext({
      storage: createStorage(),
      sessions: [],
      options: { hideChatContent: true },
    })
    const cleanup = await setupNtfyRuntime(harness.ctx)

    await waitFor("hook registration", () => harness.registrations.length > 0, 1000)
    await withDeadline(cleanup(), 1000, "first cleanup")
    await withDeadline(cleanup(), 1000, "second cleanup")
    assert.ok(harness.registrations.length > 0)
    for (const registration of harness.registrations) {
      assert.equal(
        registration.disposed,
        1,
        `${registration.domain}.${registration.name} must be disposed exactly once`,
      )
    }
  },
)

test(
  "a later hook registration failure disposes earlier registrations",
  { timeout: 4000 },
  async () => {
    const harness = createContext({
      storage: createStorage(),
      sessions: [],
      options: { hideChatContent: true },
      hookFailureAt: 2,
    })
    const outcome = await withDeadline(
      setupNtfyRuntime(harness.ctx).then(
        (cleanup) => ({ ok: true, cleanup }),
        (error) => ({ ok: false, error }),
      ),
      2000,
      "setup with failing hook registration",
    )

    if (outcome.ok) {
      await disposeQuietly(outcome.cleanup)
      assert.fail("setup should reject when a hook registration fails")
    }
    assert.match(String(outcome.error?.message), /hook registration/)
    assert.ok(harness.registrations.length >= 1, "expected at least one earlier registration")
    assert.equal(
      harness.registrations[0].disposed,
      1,
      "earlier hook registration must be disposed when a later registration fails",
    )
  },
)
