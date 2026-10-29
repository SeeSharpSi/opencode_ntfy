import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import test from "node:test"

import { createNtfyRuntime, setupNtfyRuntime } from "./index.ts"

const environmentNames = [
  "NTFY_TOPIC",
  "NTFY_SERVER",
  "NTFY_URL",
  "NTFY_TOKEN",
  "NTFY_USERNAME",
  "NTFY_PASSWORD",
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
  topic: "test-topic",
  server: "https://ntfy.example.com",
  requestTimeoutMs: 500,
  retryAttempts: 1,
  retryDelayMs: 5,
  permissionDelayMs: 10,
}

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

const flushTasks = () => new Promise((resolve) => setImmediate(resolve))
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

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

const createMock = (handlers = {}) => {
  const posts = []
  const clears = []
  const fetch = async (url, init = {}) => {
    const target = String(url)
    if (target.endsWith("/clear")) {
      const request = { url: target, init }
      clears.push(request)
      if (handlers.onClear) return handlers.onClear(request, clears.length)
      return new Response(null, { status: 200 })
    }
    if (init.method === "POST") {
      const request = { url: target, init, body: JSON.parse(init.body) }
      posts.push(request)
      if (handlers.onPost) return handlers.onPost(request, posts.length)
      return new Response(null, { status: 200 })
    }
    throw new Error(`unexpected request: ${init.method ?? "GET"} ${target}`)
  }
  return { fetch, posts, clears }
}

const makeRuntime = async (overrides = {}) => {
  const lookups = []
  const get =
    overrides.get ??
    (async ({ sessionID }) => {
      return { title: "Test session", sessionID }
    })
  const ctx = {
    options: {
      ...baseOptions,
      ...overrides.options,
    },
    session: {
      get: async (input) => {
        lookups.push(input.sessionID)
        return get(input)
      },
    },
  }
  if (overrides.location) ctx.location = overrides.location
  const runtime = await createNtfyRuntime(ctx)
  return { runtime, lookups }
}

const waitForAbort = (signal) =>
  new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener("abort", () => resolve(), { once: true })
  })

const makeSetupContext = ({ options = {}, get, subscribe }) => {
  const subscriptions = []
  let promptCallback
  let hookDisposals = 0
  const ctx = {
    options: { ...baseOptions, ...options },
    session: {
      get: async (input, requestOptions) => {
        if (get) return get(input, requestOptions)
        return { title: "Test session", sessionID: input.sessionID }
      },
      hook: async (_name, callback) => {
        promptCallback = callback
        return {
          dispose: async () => {
            hookDisposals++
          },
        }
      },
    },
    event: {
      subscribe: (requestOptions = {}) => {
        subscriptions.push(requestOptions)
        return subscribe(subscriptions.length, requestOptions)
      },
    },
  }
  return {
    ctx,
    subscriptions,
    prompt: () => promptCallback,
    hookDisposals: () => hookDisposals,
  }
}

const disposeQuietly = async (runtime) => {
  try {
    await withDeadline(runtime.dispose(), 750, "dispose")
  } catch {
    // Report the real assertion failure, not an unrelated cleanup timeout.
  }
}

const sessionID = "session-id"

const idleEvent = (id = sessionID, location) => ({
  type: "session.idle",
  data: { sessionID: id },
  ...(location ? { location } : {}),
})

const statusIdleEvent = (id = sessionID, location) => ({
  type: "session.status",
  data: { sessionID: id, status: { type: "idle" } },
  ...(location ? { location } : {}),
})

const busyEvent = (id = sessionID) => ({
  type: "session.status",
  data: { sessionID: id, status: { type: "busy" } },
})

const executionStartedEvent = (id = sessionID) => ({
  type: "session.execution.started",
  data: { sessionID: id },
})

const executionSucceededEvent = (id = sessionID) => ({
  type: "session.execution.succeeded",
  data: { sessionID: id },
})

const executionFailedEvent = (id = sessionID) => ({
  type: "session.execution.failed",
  data: { sessionID: id },
})

const executionInterruptedEvent = (id = sessionID) => ({
  type: "session.execution.interrupted",
  data: { sessionID: id },
})

const versionedExecutionEvent = (type, id, created, seq) => ({
  id: `${type}-${seq}`,
  created,
  type,
  durable: { aggregateID: id, seq, version: 1 },
  data: { sessionID: id },
})

const sessionArchivedEvent = (id = sessionID) => ({
  type: "session.archived",
  data: { sessionID: id },
})

const sessionUnarchivedEvent = (id = sessionID) => ({
  type: "session.unarchived",
  data: { sessionID: id },
})

const questionEvent = (id, idOfSession = sessionID, location) => ({
  type: "form.created",
  data: {
    form: {
      id,
      sessionID: idOfSession,
      title: "Question",
      fields: [{ type: "string", key: "answer", title: "Answer" }],
    },
  },
  ...(location ? { location } : {}),
})

const questionRepliedEvent = (id, idOfSession = sessionID) => ({
  type: "form.replied",
  data: { id, sessionID: idOfSession, answer: { answer: "yes" } },
})

const permissionEvent = (id, idOfSession = sessionID, location) => ({
  type: "permission.asked",
  data: {
    id,
    sessionID: idOfSession,
    action: "read",
    resources: ["/tmp/example"],
  },
  ...(location ? { location } : {}),
})

const permissionRepliedEvent = (requestID, idOfSession = sessionID) => ({
  type: "permission.replied",
  data: { sessionID: idOfSession, requestID, reply: "once" },
})

const sessionCreatedEvent = (id, title, parentID, location) => ({
  type: "session.created",
  data: {
    sessionID: id,
    projectID: "project-id",
    slug: id,
    title,
    ...(parentID ? { parentID } : {}),
    location: { directory: "/tmp/opencode-ntfy-runtime" },
  },
  ...(location ? { location } : {}),
})

const sessionRenamedEvent = (id, title) => ({
  type: "session.renamed",
  data: { sessionID: id, title },
})

const sessionDeletedEvent = (id = sessionID) => ({
  type: "session.deleted",
  data: { sessionID: id },
})

const completionPosts = (mock) =>
  mock.posts.filter((request) => request.body.sequence_id === `opencode-${sessionID}`)

const postsFor = (mock, sequenceID) =>
  mock.posts.filter((request) => request.body.sequence_id === sequenceID)

test(
  "concurrent and repeated idle events publish once per activity generation",
  { timeout: 2000 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime()
    try {
      await Promise.all([
        runtime.handleEvent(idleEvent()),
        runtime.handleEvent(statusIdleEvent()),
        runtime.handleEvent(idleEvent()),
        runtime.handleEvent(statusIdleEvent()),
      ])
      assert.equal(completionPosts(mock).length, 1)

      await runtime.handleEvent(idleEvent())
      await runtime.handleEvent(statusIdleEvent())
      assert.equal(completionPosts(mock).length, 1)

      await runtime.handlePrompt(sessionID)
      await runtime.handleEvent(idleEvent())
      assert.equal(completionPosts(mock).length, 2)

      await runtime.handleEvent(idleEvent())
      assert.equal(completionPosts(mock).length, 2)

      await runtime.handleEvent(executionStartedEvent())
      await runtime.handleEvent(idleEvent())
      assert.equal(completionPosts(mock).length, 3)

      await runtime.handleEvent(idleEvent())
      assert.equal(completionPosts(mock).length, 3)

      await runtime.handleEvent(busyEvent())
      await runtime.handleEvent(idleEvent())
      assert.equal(completionPosts(mock).length, 4)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "V2 execution success publishes a completion and dedups with idle fallbacks",
  { timeout: 2000 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime()
    try {
      await runtime.handleEvent(executionSucceededEvent())
      assert.equal(completionPosts(mock).length, 1)

      await runtime.handleEvent(idleEvent())
      await runtime.handleEvent(statusIdleEvent())
      assert.equal(completionPosts(mock).length, 1)

      await runtime.handlePrompt(sessionID)
      await runtime.handleEvent(executionSucceededEvent())
      assert.equal(completionPosts(mock).length, 2)

      await runtime.handleEvent(idleEvent())
      await runtime.handleEvent(statusIdleEvent())
      assert.equal(completionPosts(mock).length, 2)

      await runtime.handleEvent(executionStartedEvent())
      await runtime.handleEvent(idleEvent())
      assert.equal(completionPosts(mock).length, 3)

      await runtime.handleEvent(busyEvent())
      await runtime.handleEvent(statusIdleEvent())
      assert.equal(completionPosts(mock).length, 4)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "an old execution success cannot publish after newer activity",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime()
    try {
      await runtime.handleEvent(
        versionedExecutionEvent("session.execution.started", sessionID, 2000, 20),
      )
      await runtime.handleEvent(
        versionedExecutionEvent("session.execution.succeeded", sessionID, 1000, 10),
      )

      assert.equal(completionPosts(mock).length, 0)
      assert.equal(mock.posts.length, 0)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "an old execution failure cannot cancel a current pending completion",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const lookupStarted = deferred()
    const lookupRelease = deferred()
    const { runtime } = await makeRuntime({
      get: () => {
        lookupStarted.resolve()
        return lookupRelease.promise
      },
    })
    try {
      await runtime.handleEvent(
        versionedExecutionEvent("session.execution.started", sessionID, 2000, 20),
      )
      const current = runtime.handleEvent(
        versionedExecutionEvent("session.execution.succeeded", sessionID, 2001, 21),
      )
      await withDeadline(lookupStarted.promise, 300, "current completion lookup")
      await withDeadline(
        runtime.handleEvent(
          versionedExecutionEvent("session.execution.failed", sessionID, 1000, 10),
        ),
        300,
        "old execution failure",
      )

      lookupRelease.resolve({ title: "Test session" })
      await withDeadline(current, 300, "current completion")
      assert.equal(completionPosts(mock).length, 1)
      assert.equal(mock.posts.length, 1)
    } finally {
      lookupRelease.resolve({ title: "Test session" })
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "a duplicate native sequence is not replayed after a request changes generation",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime()
    try {
      const firstSuccess = versionedExecutionEvent(
        "session.execution.succeeded",
        sessionID,
        1000,
        10,
      )
      await runtime.handleEvent(firstSuccess)
      assert.equal(completionPosts(mock).length, 1)

      await runtime.handleEvent(questionEvent("native-duplicate-question"))
      await runtime.handleEvent(questionRepliedEvent("native-duplicate-question"))
      await runtime.handleEvent(firstSuccess)
      assert.equal(completionPosts(mock).length, 1)

      await runtime.handleEvent(
        versionedExecutionEvent("session.execution.started", sessionID, 2000, 20),
      )
      await runtime.handleEvent(
        versionedExecutionEvent("session.execution.succeeded", sessionID, 2001, 21),
      )
      assert.equal(completionPosts(mock).length, 2)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "private questions and permissions publish without waiting for session lookup",
  { timeout: 1000 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const never = new Promise(() => {})
    const { runtime, lookups } = await makeRuntime({
      get: () => never,
      options: { permissionDelayMs: 10 },
    })
    try {
      await withDeadline(
        runtime.handleEvent(questionEvent("private-question")),
        300,
        "private question",
      )
      assert.equal(lookups.length, 0)
      const question = postsFor(mock, "opencode-question-private-question")
      assert.equal(question.length, 1)
      assert.equal(question[0].body.title, "OpenCode")
      assert.equal(question[0].body.message, "Question posed")

      await withDeadline(
        runtime.handleEvent(permissionEvent("private-permission")),
        300,
        "private permission",
      )

      assert.equal(lookups.length, 0)
      const permission = postsFor(mock, "opencode-permission-private-permission")
      assert.equal(permission.length, 1)
      assert.equal(permission[0].body.title, "OpenCode")
      assert.equal(permission[0].body.message, "Permissions request")
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

for (const pendingKind of ["question", "permission"]) {
  test(
    `urgent ${pendingKind} publishes while the completion clear is stalled`,
    { timeout: 2000 },
    async () => {
      const clearStarted = deferred()
      const clearRelease = deferred()
      const mock = createMock({
        onClear: async () => {
          clearStarted.resolve()
          await clearRelease.promise
          return new Response(null, { status: 200 })
        },
      })
      const restoreFetch = useFetch(mock.fetch)
      const { runtime } = await makeRuntime({
        options: { requestTimeoutMs: 1000, permissionDelayMs: 10 },
      })
      try {
        await runtime.handleEvent(idleEvent())
        assert.equal(completionPosts(mock).length, 1)

        const prompt = runtime.handlePrompt(sessionID)
        await withDeadline(clearStarted.promise, 300, "completion clear start")

        const request =
          pendingKind === "question"
            ? runtime.handleEvent(questionEvent("urgent-question"))
            : runtime.handleEvent(permissionEvent("urgent-permission"))
        await withDeadline(request, 300, `urgent ${pendingKind}`)

        const sequenceID =
          pendingKind === "question"
            ? "opencode-question-urgent-question"
            : "opencode-permission-urgent-permission"
        assert.equal(postsFor(mock, sequenceID).length, 1)

        clearRelease.resolve()
        await withDeadline(prompt, 500, "completion clear drain")
      } finally {
        clearRelease.resolve()
        await disposeQuietly(runtime)
        restoreFetch()
      }
    },
  )
}

test(
  "failed title lookups fall back to OpenCode when privacy is disabled",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const { runtime, lookups } = await makeRuntime({
      get: async () => {
        throw new Error("lookup failed")
      },
      options: { hideChatContent: false, permissionDelayMs: 10 },
    })
    try {
      await withDeadline(
        runtime.handleEvent(questionEvent("fallback-question")),
        300,
        "fallback question",
      )
      const question = postsFor(mock, "opencode-question-fallback-question")
      assert.equal(question.length, 1)
      assert.equal(question[0].body.title, "OpenCode")
      assert.equal(question[0].body.message, "Question posed")

      await withDeadline(
        runtime.handleEvent(permissionEvent("fallback-permission")),
        300,
        "fallback permission",
      )
      const permission = postsFor(mock, "opencode-permission-fallback-permission")
      assert.equal(permission.length, 1)
      assert.equal(permission[0].body.title, "OpenCode")
      assert.equal(permission[0].body.message, "Permissions request")
      assert.equal(lookups.length, 2)
    } finally {
      await disposeQuietly(runtime)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "global form requests publish a generic alert without a session lookup",
  { timeout: 1000 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime, lookups } = await makeRuntime({
      get: async () => {
        throw new Error("global requests must not be looked up")
      },
      options: { hideChatContent: false },
    })
    try {
      await withDeadline(
        runtime.handleEvent(questionEvent("global-question", "global")),
        300,
        "global question",
      )
      const question = postsFor(mock, "opencode-question-global-question")
      assert.equal(question.length, 1)
      assert.equal(question[0].body.title, "OpenCode")
      assert.equal(question[0].body.message, "Question posed")
      assert.equal(lookups.length, 0)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "priority defaults to 4 for completion, question, and permission alerts",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime()
    try {
      await runtime.handleEvent(questionEvent("priority-question", "question-session"))
      await runtime.handleEvent(
        permissionEvent("priority-permission", "permission-session"),
      )
      await runtime.handleEvent(executionSucceededEvent("completion-session"))

      const alerts = [
        postsFor(mock, "opencode-question-priority-question")[0],
        postsFor(mock, "opencode-permission-priority-permission")[0],
        postsFor(mock, "opencode-completion-session")[0],
      ]
      for (const alert of alerts) {
        assert.ok(alert, "expected every alert type to publish")
        assert.equal(alert.body.priority, 4)
      }
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "priority falls back to the environment and an option takes precedence",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    process.env.NTFY_PRIORITY = "5"
    let environmentRuntime
    let optionRuntime
    const publishAll = async (runtime, suffix) => {
      await runtime.handleEvent(
        questionEvent(`priority-question-${suffix}`, `question-session-${suffix}`),
      )
      await runtime.handleEvent(
        permissionEvent(
          `priority-permission-${suffix}`,
          `permission-session-${suffix}`,
        ),
      )
      await runtime.handleEvent(executionSucceededEvent(`completion-session-${suffix}`))
      return [
        postsFor(mock, `opencode-question-priority-question-${suffix}`)[0],
        postsFor(mock, `opencode-permission-priority-permission-${suffix}`)[0],
        postsFor(mock, `opencode-completion-session-${suffix}`)[0],
      ]
    }
    try {
      ;({ runtime: environmentRuntime } = await makeRuntime())
      for (const alert of await publishAll(environmentRuntime, "environment")) {
        assert.ok(alert, "expected environment-priority alerts to publish")
        assert.equal(alert.body.priority, 5)
      }

      ;({ runtime: optionRuntime } = await makeRuntime({ options: { priority: 3 } }))
      for (const alert of await publishAll(optionRuntime, "option")) {
        assert.ok(alert, "expected option-priority alerts to publish")
        assert.equal(alert.body.priority, 3)
      }
    } finally {
      delete process.env.NTFY_PRIORITY
      if (environmentRuntime) await disposeQuietly(environmentRuntime)
      if (optionRuntime) await disposeQuietly(optionRuntime)
      restoreFetch()
    }
  },
)

test("invalid priority values reject setup", { timeout: 1000 }, async () => {
  const context = {
    session: { get: async () => ({ title: "Test session" }) },
  }
  for (const priority of [0, 6, "not-a-number"]) {
    await assert.rejects(
      createNtfyRuntime({
        ...context,
        options: { ...baseOptions, priority },
      }),
      /priority/i,
      `priority option ${JSON.stringify(priority)} must reject`,
    )
  }

  process.env.NTFY_PRIORITY = "0"
  try {
    await assert.rejects(
      createNtfyRuntime({
        ...context,
        options: baseOptions,
      }),
      /priority/i,
      "out-of-range environment priority must reject",
    )
  } finally {
    delete process.env.NTFY_PRIORITY
  }
})

const numericOptionCases = [
  {
    name: "requestTimeoutMs",
    env: "NTFY_REQUEST_TIMEOUT_MS",
    valid: 200,
    invalid: [0, 120_001, 1.5, "not-a-number"],
  },
  {
    name: "retryAttempts",
    env: "NTFY_RETRY_ATTEMPTS",
    valid: 2,
    invalid: [0, 6, 1.5, "not-a-number"],
  },
  {
    name: "retryDelayMs",
    env: "NTFY_RETRY_DELAY_MS",
    valid: 5,
    invalid: [-1, 30_001, 1.5, "not-a-number"],
  },
  {
    name: "permissionDelayMs",
    env: "NTFY_PERMISSION_DELAY_MS",
    valid: 10,
    invalid: [-1, 60_001, 1.5, "not-a-number"],
  },
]

test(
  "numeric runtime options reject out-of-range, fractional, and non-numeric values",
  { timeout: 1500 },
  async () => {
    const context = {
      session: { get: async () => ({ title: "Test session" }) },
    }
    for (const { name, invalid } of numericOptionCases) {
      for (const value of invalid) {
        await assert.rejects(
          createNtfyRuntime({
            ...context,
            options: { ...baseOptions, [name]: value },
          }),
          new RegExp(name),
          `${name} option ${JSON.stringify(value)} must reject`,
        )
      }
    }
  },
)

test(
  "numeric runtime options use environment fallback and options override invalid environment",
  { timeout: 2000 },
  async () => {
    const mock = createMock({
      onPost: async (request) => {
        attempts++
        if (
          request.body.sequence_id === "opencode-question-env-fallback" &&
          attempts === 1
        ) {
          return new Response("unavailable", { status: 503 })
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    let attempts = 0
    let environmentRuntime
    let optionRuntime
    try {
      for (const { env, valid } of numericOptionCases) {
        process.env[env] = String(valid)
      }
      ;({ runtime: environmentRuntime } = await makeRuntime({
        options: { requestTimeoutMs: undefined, retryAttempts: undefined, retryDelayMs: undefined, permissionDelayMs: undefined },
      }))
      await withDeadline(
        environmentRuntime.handleEvent(questionEvent("env-fallback")),
        700,
        "environment fallback question",
      )
      assert.equal(attempts, 2)

      await disposeQuietly(environmentRuntime)
      environmentRuntime = undefined
      attempts = 0
      for (const { env } of numericOptionCases) {
        process.env[env] = "not-a-number"
      }
      ;({ runtime: optionRuntime } = await makeRuntime({
        options: {
          requestTimeoutMs: 200,
          retryAttempts: 1,
          retryDelayMs: 5,
          permissionDelayMs: 10,
        },
      }))
      await withDeadline(
        optionRuntime.handleEvent(questionEvent("option-override")),
        700,
        "option override question",
      )
      assert.equal(attempts, 1)
    } finally {
      for (const { env } of numericOptionCases) delete process.env[env]
      if (environmentRuntime) await disposeQuietly(environmentRuntime)
      if (optionRuntime) await disposeQuietly(optionRuntime)
      restoreFetch()
    }
  },
)

for (const pendingKind of ["question", "permission"]) {
  test(
    `delayed ${pendingKind} alert suppresses a pending completion`,
    { timeout: 1500 },
    async () => {
      const mock = createMock()
      const restoreFetch = useFetch(mock.fetch)
      const lookupStarted = deferred()
      const lookupRelease = deferred()
      let lookupCount = 0
      const { runtime } = await makeRuntime({
        get: () => {
          lookupCount++
          lookupStarted.resolve()
          return lookupRelease.promise
        },
        options: { permissionDelayMs: 10 },
      })
      try {
        const idle = runtime.handleEvent(idleEvent())
        await withDeadline(lookupStarted.promise, 300, "completion lookup start")

        const request =
          pendingKind === "question"
            ? runtime.handleEvent(questionEvent("pending-question"))
            : runtime.handleEvent(permissionEvent("pending-permission"))
        await withDeadline(request, 300, `${pendingKind} alert`)
        assert.equal(mock.posts.filter((entry) => !entry.body.sequence_id?.startsWith("opencode-session-")).length, 1)

        lookupRelease.resolve({ title: "Test session", parentID: undefined })
        await withDeadline(idle, 300, "delayed completion")
        assert.equal(completionPosts(mock).length, 0)
        assert.equal(lookupCount, 1)
      } finally {
        await disposeQuietly(runtime)
        restoreFetch()
      }
    },
  )
}

const invalidationCases = [
  ["busy status", (runtime) => runtime.handleEvent(busyEvent())],
  ["execution start", (runtime) => runtime.handleEvent(executionStartedEvent())],
  ["deletion", (runtime) => runtime.handleEvent(sessionDeletedEvent())],
  ["dispose", (runtime) => runtime.dispose()],
]

for (const [name, invalidate] of invalidationCases) {
  test(
    `delayed completion is invalidated by ${name}`,
    { timeout: 1500 },
    async () => {
      const mock = createMock()
      const restoreFetch = useFetch(mock.fetch)
      const lookupStarted = deferred()
      const lookupRelease = deferred()
      const { runtime } = await makeRuntime({
        get: () => {
          lookupStarted.resolve()
          return lookupRelease.promise
        },
      })
      try {
        const idle = runtime.handleEvent(idleEvent())
        await withDeadline(lookupStarted.promise, 300, "completion lookup start")

        await withDeadline(invalidate(runtime), 300, name)
        lookupRelease.resolve({ title: "Test session" })
        await withDeadline(idle, 300, "invalidated completion")

        assert.equal(completionPosts(mock).length, 0)
      } finally {
        await disposeQuietly(runtime)
        restoreFetch()
      }
    },
  )
}

for (const terminalType of ["session.execution.failed", "session.execution.interrupted"]) {
  test(
    `a newer ${terminalType} cancels a pending success completion`,
    { timeout: 1500 },
    async () => {
      const mock = createMock()
      const restoreFetch = useFetch(mock.fetch)
      const lookupStarted = deferred()
      const lookupRelease = deferred()
      const { runtime } = await makeRuntime({
        get: () => {
          lookupStarted.resolve()
          return lookupRelease.promise
        },
      })
      try {
        const completion = runtime.handleEvent(
          versionedExecutionEvent("session.execution.succeeded", sessionID, 2000, 20),
        )
        await withDeadline(lookupStarted.promise, 300, "success completion lookup")
        await withDeadline(
          runtime.handleEvent(versionedExecutionEvent(terminalType, sessionID, 3000, 30)),
          300,
          terminalType,
        )

        lookupRelease.resolve({ title: "Test session" })
        await withDeadline(completion, 300, "cancelled success completion")
        await flushTasks()

        assert.equal(completionPosts(mock).length, 0)
        assert.equal(mock.posts.length, 0)
      } finally {
        lookupRelease.resolve({ title: "Test session" })
        await disposeQuietly(runtime)
        restoreFetch()
      }
    },
  )
}

for (const [terminalName, terminalEvent] of [
  ["failure", executionFailedEvent],
  ["interruption", executionInterruptedEvent],
]) {
  for (const [fallbackName, fallbackEvent] of [
    ["session.idle", idleEvent],
    ["session.status idle", statusIdleEvent],
  ]) {
    test(
      `${terminalName} blocks ${fallbackName} completions until a new execution succeeds`,
      { timeout: 1500 },
      async () => {
        const mock = createMock()
        const restoreFetch = useFetch(mock.fetch)
        const { runtime } = await makeRuntime()
        try {
          await runtime.handleEvent(terminalEvent())
          await runtime.handleEvent(fallbackEvent())
          assert.equal(completionPosts(mock).length, 0)

          await runtime.handleEvent(executionStartedEvent())
          await runtime.handleEvent(executionSucceededEvent())
          assert.equal(completionPosts(mock).length, 1)
        } finally {
          await disposeQuietly(runtime)
          restoreFetch()
        }
      },
    )
  }
}

test(
  "a completion queued behind a stalled clear is skipped after a newer prompt",
  { timeout: 2000 },
  async () => {
    const mock = createMock({
      onClear: async () => {
        clearStarted.resolve()
        await clearRelease.promise
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const clearStarted = deferred()
    const clearRelease = deferred()
    const { runtime } = await makeRuntime({
      options: { requestTimeoutMs: 1000 },
    })
    try {
      await runtime.handleEvent(idleEvent())
      assert.equal(completionPosts(mock).length, 1)

      const firstPrompt = runtime.handlePrompt(sessionID)
      await withDeadline(clearStarted.promise, 300, "stalled clear start")

      const queuedIdle = runtime.handleEvent(idleEvent())
      await flushTasks()
      await flushTasks()

      const secondPrompt = runtime.handlePrompt(sessionID)
      await flushTasks()
      clearRelease.resolve()

      await withDeadline(
        Promise.all([firstPrompt, queuedIdle, secondPrompt]),
        500,
        "queued completion drain",
      )
      assert.equal(completionPosts(mock).length, 1)
    } finally {
      clearRelease.resolve()
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "dispose skips ordinary clears queued behind an aborted clear",
  { timeout: 2000 },
  async () => {
    const clearStarted = deferred()
    const clearCalls = []
    let firstClear = true
    const mock = createMock({
      onClear: async (request) => {
        clearCalls.push(request.url)
        if (firstClear) {
          firstClear = false
          clearStarted.resolve()
          await waitForAbort(request.init.signal)
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime({
      options: { requestTimeoutMs: 1000 },
    })
    try {
      await runtime.handleEvent(idleEvent())
      assert.equal(completionPosts(mock).length, 1)

      const firstPrompt = runtime.handlePrompt(sessionID)
      await withDeadline(clearStarted.promise, 300, "first clear start")

      const secondPrompt = runtime.handlePrompt(sessionID)
      const thirdPrompt = runtime.handlePrompt(sessionID)
      const disposal = runtime.dispose()

      await withDeadline(
        Promise.all([firstPrompt, secondPrompt, thirdPrompt, disposal]),
        500,
        "dispose clear drain",
      )

      assert.equal(clearCalls.length, 2)
      assert.equal(mock.clears.length, 2)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "a transient delivery failure retries once and then succeeds",
  { timeout: 1500 },
  async () => {
    let attempts = 0
    const mock = createMock({
      onPost: async () => {
        attempts++
        if (attempts === 1) return new Response("unavailable", { status: 503 })
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime({
      options: { retryAttempts: 2, retryDelayMs: 10, requestTimeoutMs: 200 },
    })
    try {
      await withDeadline(
        runtime.handleEvent(questionEvent("retried-question")),
        500,
        "retried question",
      )
      assert.equal(attempts, 2)
      assert.equal(postsFor(mock, "opencode-question-retried-question").length, 2)
      assert.equal(
        new Set(
          postsFor(mock, "opencode-question-retried-question").map(
            (entry) => entry.body.sequence_id,
          ),
        ).size,
        1,
      )
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "a reply during retry backoff cancels the stale publish",
  { timeout: 1500 },
  async () => {
    let attempts = 0
    const firstAttempt = deferred()
    const mock = createMock({
      onPost: async () => {
        attempts++
        if (attempts === 1) {
          firstAttempt.resolve()
          return new Response("unavailable", { status: 503 })
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime({
      options: { retryAttempts: 3, retryDelayMs: 60, requestTimeoutMs: 200 },
    })
    try {
      const asked = runtime.handleEvent(questionEvent("cancelled-question"))
      await withDeadline(firstAttempt.promise, 300, "first attempt")
      await withDeadline(
        runtime.handleEvent(questionRepliedEvent("cancelled-question")),
        500,
        "question reply",
      )
      await withDeadline(asked, 500, "cancelled question")
      await delay(150)

      assert.equal(attempts, 1)
      assert.equal(postsFor(mock, "opencode-question-cancelled-question").length, 1)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "duplicate pending and successful requests publish only once",
  { timeout: 1500 },
  async () => {
    const duplicateStarted = deferred()
    const duplicateRelease = deferred()
    const mock = createMock({
      onPost: async (request) => {
        if (request.body.sequence_id === "opencode-question-duplicate-question") {
          duplicateStarted.resolve()
          await duplicateRelease.promise
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime({ options: { permissionDelayMs: 10 } })
    try {
      const first = runtime.handleEvent(questionEvent("duplicate-question"))
      await withDeadline(duplicateStarted.promise, 300, "duplicate question start")
      const second = runtime.handleEvent(questionEvent("duplicate-question"))
      await withDeadline(second, 300, "duplicate question while pending")

      duplicateRelease.resolve()
      await withDeadline(first, 300, "first duplicate question")
      await withDeadline(
        runtime.handleEvent(questionEvent("duplicate-question")),
        300,
        "duplicate question after success",
      )

      assert.equal(postsFor(mock, "opencode-question-duplicate-question").length, 1)

      await withDeadline(
        Promise.all([
          runtime.handleEvent(permissionEvent("duplicate-permission")),
          runtime.handleEvent(permissionEvent("duplicate-permission")),
        ]),
        500,
        "duplicate permissions",
      )
      await withDeadline(
        runtime.handleEvent(permissionEvent("duplicate-permission")),
        300,
        "duplicate permission after success",
      )
      assert.equal(
        postsFor(mock, "opencode-permission-duplicate-permission").length,
        1,
      )
    } finally {
      duplicateRelease.resolve()
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "a failed non-retryable request can be attempted again on a later asked event",
  { timeout: 1500 },
  async () => {
    const attempts = new Map()
    const mock = createMock({
      onPost: async (request) => {
        const sequenceID = request.body.sequence_id
        const count = (attempts.get(sequenceID) ?? 0) + 1
        attempts.set(sequenceID, count)
        if (sequenceID === "opencode-question-retry-after-failure" && count === 1) {
          return new Response(
            JSON.stringify({ code: 40301, http: 403, error: "forbidden" }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const { runtime } = await makeRuntime()
    try {
      await withDeadline(
        runtime.handleEvent(questionEvent("retry-after-failure")),
        500,
        "failed question",
      )
      assert.equal(
        postsFor(mock, "opencode-question-retry-after-failure").length,
        1,
      )

      await withDeadline(
        runtime.handleEvent(questionEvent("retry-after-failure")),
        500,
        "retried question event",
      )
      assert.equal(
        postsFor(mock, "opencode-question-retry-after-failure").length,
        2,
      )
      assert.equal(
        attempts.get("opencode-question-retry-after-failure"),
        2,
      )
    } finally {
      await disposeQuietly(runtime)
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "session metadata cache distinguishes roots and children without extra reads",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime, lookups } = await makeRuntime({
      get: async () => {
        throw new Error("session lookup should use the metadata cache")
      },
      options: { hideChatContent: false },
    })
    try {
      await runtime.handleEvent(sessionCreatedEvent("root-session", "Cached title"))
      await runtime.handleEvent(idleEvent("root-session"))
      const firstCompletion = mock.posts.filter(
        (entry) => entry.body.sequence_id === "opencode-root-session",
      )
      assert.equal(firstCompletion.length, 1)
      assert.equal(firstCompletion[0].body.title, "Cached title")
      assert.equal(lookups.length, 0)

      await runtime.handleEvent(
        sessionRenamedEvent("root-session", "Renamed cached title"),
      )
      await runtime.handlePrompt("root-session")
      await runtime.handleEvent(idleEvent("root-session"))
      const completions = mock.posts.filter(
        (entry) => entry.body.sequence_id === "opencode-root-session",
      )
      assert.equal(completions.length, 2)
      assert.equal(completions[1].body.title, "Renamed cached title")
      assert.equal(lookups.length, 0)

      await runtime.handleEvent(
        sessionCreatedEvent("child-session", "Child title", "root-session"),
      )
      await runtime.handleEvent(executionStartedEvent("child-session"))
      await runtime.handleEvent(idleEvent("child-session"))
      assert.equal(
        mock.posts.filter(
          (entry) => entry.body.sequence_id === "opencode-child-session",
        ).length,
        0,
      )
      assert.equal(lookups.length, 0)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "session metadata from get is cached across completion activity cycles",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const lookups = new Map()
    const { runtime } = await makeRuntime({
      get: async ({ sessionID: id }) => {
        lookups.set(id, (lookups.get(id) ?? 0) + 1)
        if (id === "child-session") {
          return { title: "Child title", parentID: "root-session" }
        }
        return { title: "Cached root title" }
      },
      options: { hideChatContent: false },
    })
    try {
      await runtime.handleEvent(idleEvent("root-session"))
      await runtime.handlePrompt("root-session")
      await runtime.handleEvent(executionStartedEvent("root-session"))
      await runtime.handleEvent(executionSucceededEvent("root-session"))

      const rootCompletions = mock.posts.filter(
        (entry) => entry.body.sequence_id === "opencode-root-session",
      )
      assert.equal(rootCompletions.length, 2)
      assert.equal(rootCompletions[0].body.title, "Cached root title")
      assert.equal(rootCompletions[1].body.title, "Cached root title")
      assert.equal(lookups.get("root-session"), 1)

      await runtime.handleEvent(idleEvent("child-session"))
      await runtime.handlePrompt("child-session")
      await runtime.handleEvent(executionStartedEvent("child-session"))
      await runtime.handleEvent(executionSucceededEvent("child-session"))

      assert.equal(
        mock.posts.filter(
          (entry) => entry.body.sequence_id === "opencode-child-session",
        ).length,
        0,
      )
      assert.equal(lookups.get("child-session"), 1)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "a deleted session clears request alerts and suppresses delayed permissions",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime({ options: { permissionDelayMs: 30 } })
    try {
      await runtime.handleEvent(questionEvent("archived-question", "archived-session"))
      await withDeadline(
        runtime.handleEvent(permissionEvent("archived-permission", "archived-session")),
        300,
        "published permission",
      )
      assert.equal(
        postsFor(mock, "opencode-question-archived-question").length,
        1,
      )
      assert.equal(
        postsFor(mock, "opencode-permission-archived-permission").length,
        1,
      )

      await withDeadline(
        runtime.handleEvent(sessionDeletedEvent("archived-session")),
        300,
        "session deletion",
      )
      const cleared = mock.clears.map((request) => request.url).sort()
      assert.deepEqual(cleared, [
        "https://ntfy.example.com/test-topic/opencode-archived-session/clear",
        "https://ntfy.example.com/test-topic/opencode-permission-archived-permission/clear",
        "https://ntfy.example.com/test-topic/opencode-question-archived-question/clear",
      ])

      const latePermission = runtime.handleEvent(
        permissionEvent("late-archived-permission", "deleted-session"),
      )
      await withDeadline(
        runtime.handleEvent(sessionDeletedEvent("deleted-session")),
        300,
        "delete before permission grace",
      )
      await withDeadline(latePermission, 300, "late archived permission")
      await delay(80)

      assert.equal(
        postsFor(mock, "opencode-permission-late-archived-permission").length,
        0,
      )
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "an archived session clears request alerts and suppresses delayed permissions",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime } = await makeRuntime({ options: { permissionDelayMs: 30 } })
    try {
      await runtime.handleEvent(questionEvent("archive-question", "archive-session"))
      await withDeadline(
        runtime.handleEvent(permissionEvent("archive-permission", "archive-session")),
        300,
        "published archive permission",
      )

      await withDeadline(
        runtime.handleEvent(sessionArchivedEvent("archive-session")),
        300,
        "session archive",
      )
      assert.deepEqual(
        mock.clears.map((request) => request.url).sort(),
        [
          "https://ntfy.example.com/test-topic/opencode-archive-session/clear",
          "https://ntfy.example.com/test-topic/opencode-permission-archive-permission/clear",
          "https://ntfy.example.com/test-topic/opencode-question-archive-question/clear",
        ],
      )

      const latePermission = runtime.handleEvent(
        permissionEvent("late-archive-permission", "newly-archived-session"),
      )
      await withDeadline(
        runtime.handleEvent(sessionArchivedEvent("newly-archived-session")),
        300,
        "archive before permission grace",
      )
      await withDeadline(latePermission, 300, "late archived permission")
      await delay(80)

      assert.equal(
        postsFor(mock, "opencode-permission-late-archive-permission").length,
        0,
      )
      await runtime.handleEvent(sessionUnarchivedEvent("newly-archived-session"))
      assert.equal(
        postsFor(mock, "opencode-permission-late-archive-permission").length,
        0,
      )
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "an archived session from session.get cannot publish a completion",
  { timeout: 1000 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime, lookups } = await makeRuntime({
      get: async () => ({
        title: "Archived session",
        time: { archived: 1234567890 },
      }),
      options: { hideChatContent: false },
    })
    try {
      await runtime.handleEvent(idleEvent())
      await runtime.handleEvent(executionSucceededEvent())
      assert.equal(lookups.length, 1)
      assert.equal(completionPosts(mock).length, 0)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "events for another directory are ignored when the runtime has a location",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime, lookups } = await makeRuntime({
      location: { directory: "/tmp/opencode-ntfy-runtime" },
    })
    try {
      await runtime.handleEvent(
        idleEvent(sessionID, { directory: "/tmp/another-project" }),
      )
      await runtime.handleEvent(
        questionEvent("other-location-question", sessionID, {
          directory: "/tmp/another-project",
        }),
      )
      assert.equal(mock.posts.length, 0)
      assert.equal(lookups.length, 0)

      await runtime.handleEvent(
        idleEvent(sessionID, { directory: "/tmp/opencode-ntfy-runtime" }),
      )
      await runtime.handleEvent(
        questionEvent("matching-location-question", sessionID, {
          directory: "/tmp/opencode-ntfy-runtime",
        }),
      )
      assert.equal(completionPosts(mock).length, 1)
      assert.equal(
        postsFor(mock, "opencode-question-matching-location-question").length,
        1,
      )
      assert.equal(
        postsFor(mock, "opencode-question-other-location-question").length,
        0,
      )
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "post-dispose handlers are no-ops and dispose is idempotent",
  { timeout: 1500 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const { runtime, lookups } = await makeRuntime()
    try {
      await withDeadline(runtime.dispose(), 300, "first dispose")
      await withDeadline(runtime.dispose(), 300, "second dispose")

      await runtime.handleEvent(idleEvent())
      await runtime.handleEvent(statusIdleEvent())
      await runtime.handleEvent(questionEvent("post-dispose-question"))
      await runtime.handleEvent(permissionEvent("post-dispose-permission"))
      await runtime.handlePrompt(sessionID)

      assert.equal(lookups.length, 0)
      assert.equal(mock.posts.length, 0)
    } finally {
      await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "plugin prompt hooks return before a stalled completion clear",
  { timeout: 2000 },
  async () => {
    const completionPublished = deferred()
    const clearStarted = deferred()
    const clearRelease = deferred()
    const mock = createMock({
      onPost: async () => {
        completionPublished.resolve()
        return new Response(null, { status: 200 })
      },
      onClear: async () => {
        clearStarted.resolve()
        await clearRelease.promise
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const { ctx, prompt } = makeSetupContext({
      options: { requestTimeoutMs: 1000 },
      subscribe: (_call, requestOptions) =>
        (async function* () {
          yield idleEvent()
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(ctx)
    try {
      await withDeadline(completionPublished.promise, 500, "completion publish")
      const callback = prompt()
      assert.equal(typeof callback, "function")

      const started = Date.now()
      await withDeadline(
        Promise.resolve(callback({ sessionID })),
        100,
        "prompt hook callback",
      )
      const elapsed = Date.now() - started
      assert.ok(elapsed < 100, `prompt hook waited ${elapsed}ms for ntfy I/O`)

      await withDeadline(clearStarted.promise, 300, "stalled clear")
    } finally {
      clearRelease.resolve()
      await withDeadline(cleanup(), 750, "plugin cleanup")
      restoreFetch()
    }
  },
)

test(
  "plugin resubscribes after thrown and closed event streams",
  { timeout: 4000 },
  async () => {
    const completionPublished = deferred()
    const thirdSubscription = deferred()
    const mock = createMock({
      onPost: async (request) => {
        if (request.body.sequence_id === `opencode-${sessionID}`) {
          completionPublished.resolve()
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    let subscriptionCalls = 0
    const { ctx } = makeSetupContext({
      subscribe: (call, requestOptions) => {
        subscriptionCalls = Math.max(subscriptionCalls, call)
        if (call === 3) thirdSubscription.resolve()
        return (async function* () {
          if (call === 1) throw new Error("stream failed")
          if (call === 2) {
            yield executionSucceededEvent()
            return
          }
          await waitForAbort(requestOptions.signal)
        })()
      },
    })
    const cleanup = await setupNtfyRuntime(ctx)
    try {
      await withDeadline(completionPublished.promise, 1500, "reconnected completion")
      await withDeadline(thirdSubscription.promise, 1500, "third subscription")
      assert.ok(subscriptionCalls >= 3)
      assert.equal(completionPosts(mock).length, 1)
    } finally {
      await withDeadline(cleanup(), 750, "plugin cleanup")
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "plugin cleanup cancels pending work before awaiting tasks",
  { timeout: 2000 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const lookupStarted = deferred()
    const never = new Promise(() => {})
    const { ctx } = makeSetupContext({
      options: { requestTimeoutMs: 5000 },
      get: () => {
        lookupStarted.resolve()
        return never
      },
      subscribe: (_call, requestOptions) =>
        (async function* () {
          yield idleEvent()
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(ctx)
    try {
      await withDeadline(lookupStarted.promise, 500, "pending lookup start")
      const started = Date.now()
      await withDeadline(cleanup(), 750, "plugin cleanup")
      const elapsed = Date.now() - started
      assert.ok(elapsed < 750, `cleanup waited ${elapsed}ms for pending work`)
      assert.equal(completionPosts(mock).length, 0)
    } finally {
      restoreFetch()
    }
  },
)

test(
  "plugin subscription requests the native event types it handles",
  { timeout: 1500 },
  async () => {
    const { ctx, subscriptions } = makeSetupContext({
      subscribe: (_call, requestOptions) =>
        (async function* () {
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(ctx)
    try {
      assert.ok(subscriptions.length >= 1)
      const types = subscriptions[0].types
      assert.ok(Array.isArray(types), "subscription types must be an array")
      for (const type of [
        "session.execution.succeeded",
        "form.created",
        "permission.asked",
      ]) {
        assert.ok(types.includes(type), `subscription types must include ${type}`)
      }
    } finally {
      await withDeadline(cleanup(), 750, "plugin cleanup")
    }
  },
)

test(
  "plugin resubscribes after a stream throws AbortError without shutdown",
  { timeout: 2000 },
  async () => {
    const subscribedAgain = deferred()
    const questionPublished = deferred()
    const mock = createMock({
      onPost: async (request) => {
        if (request.body.sequence_id === "opencode-question-after-abort-error") {
          questionPublished.resolve()
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    let subscriptionCalls = 0
    const { ctx } = makeSetupContext({
      subscribe: (call, requestOptions) => {
        subscriptionCalls = Math.max(subscriptionCalls, call)
        if (call === 2) subscribedAgain.resolve()
        return (async function* () {
          if (call === 1) {
            throw new DOMException("stream aborted", "AbortError")
          }
          if (call === 2) {
            yield questionEvent("after-abort-error")
          }
          await waitForAbort(requestOptions.signal)
        })()
      },
    })
    const cleanup = await setupNtfyRuntime(ctx)
    try {
      await withDeadline(subscribedAgain.promise, 1000, "resubscribe after AbortError")
      await withDeadline(questionPublished.promise, 1000, "event after AbortError")
      assert.equal(subscriptionCalls, 2)
      assert.equal(
        postsFor(mock, "opencode-question-after-abort-error").length,
        1,
      )
    } finally {
      await withDeadline(cleanup(), 1000, "plugin cleanup")
      silent.restore()
      restoreFetch()
    }
  },
)

test(
  "plugin cleanup disposes the prompt hook exactly once",
  { timeout: 1500 },
  async () => {
    const { ctx, hookDisposals } = makeSetupContext({
      subscribe: (_call, requestOptions) =>
        (async function* () {
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(ctx)
    await withDeadline(cleanup(), 750, "first plugin cleanup")
    await withDeadline(cleanup(), 750, "second plugin cleanup")
    assert.equal(hookDisposals(), 1)
  },
)

test(
  "a quick completion leaves no request timeout timers behind",
  { timeout: 2000 },
  async () => {
    const mock = createMock()
    const restoreFetch = useFetch(mock.fetch)
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const trackedTimers = new Set()
    const requestTimeoutMs = 1111
    globalThis.setTimeout = (callback, milliseconds, ...args) => {
      const timer = originalSetTimeout(callback, milliseconds, ...args)
      if (milliseconds === requestTimeoutMs) trackedTimers.add(timer)
      return timer
    }
    globalThis.clearTimeout = (timer) => {
      trackedTimers.delete(timer)
      return originalClearTimeout(timer)
    }

    let runtime
    try {
      runtime = await createNtfyRuntime({
        options: {
          ...baseOptions,
          requestTimeoutMs,
          retryAttempts: 1,
        },
        session: {
          get: async () => ({ title: "Test session" }),
        },
      })
      await runtime.handleEvent(executionSucceededEvent())
      assert.equal(completionPosts(mock).length, 1)
      assert.equal(trackedTimers.size, 0)
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      for (const timer of trackedTimers) originalClearTimeout(timer)
      if (runtime) await disposeQuietly(runtime)
      restoreFetch()
    }
  },
)

test(
  "reconnect abort listeners stay bounded across repeated failures",
  { timeout: 4000 },
  async () => {
    const thirteenthSubscription = deferred()
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const silent = useSilentConsoleError()
    const deadlineWithOriginalTimer = (promise, milliseconds, label) =>
      new Promise((resolve, reject) => {
        const timer = originalSetTimeout(
          () => reject(new Error(`${label} did not settle within ${milliseconds}ms`)),
          milliseconds,
        )
        promise.then(
          (value) => {
            originalClearTimeout(timer)
            resolve(value)
          },
          (error) => {
            originalClearTimeout(timer)
            reject(error)
          },
        )
      })

    let thirteenthSignal
    let subscriptionCalls = 0
    const { ctx } = makeSetupContext({
      options: { requestTimeoutMs: 200, retryAttempts: 1 },
      subscribe: (call, requestOptions) => {
        subscriptionCalls = Math.max(subscriptionCalls, call)
        if (call === 13) {
          thirteenthSignal = requestOptions.signal
          thirteenthSubscription.resolve()
        }
        return (async function* () {
          if (call <= 12) throw new Error("stream failed")
          await waitForAbort(requestOptions.signal)
        })()
      },
    })

    let cleanup
    try {
      globalThis.setTimeout = (callback, milliseconds, ...args) =>
        originalSetTimeout(
          callback,
          typeof milliseconds === "number" && milliseconds >= 250 ? 0 : milliseconds,
          ...args,
        )
      cleanup = await setupNtfyRuntime(ctx)
      await deadlineWithOriginalTimer(
        thirteenthSubscription.promise,
        2500,
        "thirteenth subscription",
      )
      assert.equal(subscriptionCalls, 13)
      assert.ok(thirteenthSignal)
      assert.ok(
        getEventListeners(thirteenthSignal, "abort").length <= 2,
        "reconnect should not retain one abort listener per failed stream",
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      if (cleanup) await withDeadline(cleanup(), 1000, "plugin cleanup")
      silent.restore()
    }
  },
)

test(
  "plugin observes handler rejections and keeps consuming events",
  { timeout: 2000 },
  async () => {
    const questionPublished = deferred()
    const mock = createMock({
      onPost: async (request) => {
        if (request.body.sequence_id === "opencode-question-after-rejection") {
          questionPublished.resolve()
        }
        return new Response(null, { status: 200 })
      },
    })
    const restoreFetch = useFetch(mock.fetch)
    const silent = useSilentConsoleError()
    const badEvent = {
      type: "session.idle",
      data: { sessionID },
      get location() {
        throw new Error("bad event location")
      },
    }
    const { ctx } = makeSetupContext({
      subscribe: (_call, requestOptions) =>
        (async function* () {
          yield badEvent
          yield questionEvent("after-rejection")
          await waitForAbort(requestOptions.signal)
        })(),
    })
    const cleanup = await setupNtfyRuntime(ctx)
    try {
      await withDeadline(questionPublished.promise, 500, "event after rejection")
      assert.ok(
        silent.calls.some((args) =>
          /notification task failed:.*bad event location/.test(String(args[0])),
        ),
        "expected the handler rejection to be logged",
      )
    } finally {
      await withDeadline(cleanup(), 750, "plugin cleanup")
      silent.restore()
      restoreFetch()
    }
  },
)
