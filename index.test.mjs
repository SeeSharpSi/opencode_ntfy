import assert from "node:assert/strict"
import test from "node:test"

import { NtfyPlugin } from "./index.ts"

const environmentNames = [
  "NTFY_TOPIC",
  "NTFY_SERVER",
  "NTFY_URL",
  "NTFY_TOKEN",
  "NTFY_USERNAME",
  "NTFY_PASSWORD",
  "NTFY_HIDE_CHAT_CONTENT",
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

const input = {
  client: {
    session: {
      get: async () => ({ data: { title: "Test session" } }),
    },
  },
  directory: "/tmp/opencode-ntfy-test",
}

test("plugin options override environment for question notifications", { timeout: 1000 }, async () => {
  const originalFetch = globalThis.fetch
  const cleared = []
  let resolvePayload
  const payload = new Promise((resolve) => {
    resolvePayload = resolve
  })

  process.env.NTFY_TOPIC = "environment-topic"
  process.env.NTFY_SERVER = "https://environment.example.com"
  process.env.NTFY_TOKEN = "environment-primary-token"
  process.env.NTFY_USERNAME = "environment-user"
  process.env.NTFY_PASSWORD = "environment-password"

  globalThis.fetch = async (url, options = {}) => {
    assert.match(String(url), /^https:\/\/ntfy\.example\.com\//)
    if (String(url).endsWith("/clear")) {
      cleared.push(String(url))
      assert.equal(options.method, "PUT")
      assert.equal(options.headers.Authorization, "Bearer primary-token")
      return new Response(null, { status: 200 })
    }

    const body = JSON.parse(options.body)
    resolvePayload(body)
    assert.equal(options.headers.Authorization, "Bearer primary-token")
    return new Response(null, { status: 200 })
  }

  const hooks = await NtfyPlugin(input, {
    topic: "test-topic",
    server: "https://ntfy.example.com",
    token: "primary-token",
    hideChatContent: false,
  })

  try {
    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "request-id",
          sessionID: "session-id",
          questions: [
            {
              header: "Deploy?",
              question: "Choose an action",
              options: [{ label: "Yes", description: "Deploy now" }],
            },
          ],
        },
      },
    })

    const notification = await payload
    assert.equal(notification.topic, "test-topic")
    assert.equal(notification.title, "Test session")
    assert.equal(notification.message, "OpenCode has a question.")
    assert.equal("actions" in notification, false)
    assert.equal("click" in notification, false)
    assert.equal(notification.sequence_id, "opencode-question-request-id")
    assert.doesNotMatch(JSON.stringify(notification), /Deploy\?|Choose an action|Deploy now/)
    assert.doesNotMatch(JSON.stringify(notification), /primary-token/)
    await hooks.dispose()
    assert.deepEqual(cleared, [
      `https://ntfy.example.com/test-topic/${notification.sequence_id}/clear`,
    ])
  } finally {
    await hooks.dispose()
    globalThis.fetch = originalFetch
    for (const name of environmentNames) delete process.env[name]
  }
})

test("dispose waits for an in-flight completion publish before clearing it", { timeout: 1000 }, async () => {
  const originalFetch = globalThis.fetch
  const operations = []
  let resolvePublishStarted
  let resolvePublish
  const publishStarted = new Promise((resolve) => {
    resolvePublishStarted = resolve
  })
  const publishReleased = new Promise((resolve) => {
    resolvePublish = resolve
  })

  globalThis.fetch = async (url, options = {}) => {
    if (options.method === "POST") {
      operations.push("publish started")
      resolvePublishStarted()
      await publishReleased
      operations.push("publish finished")
      return new Response(null, { status: 200 })
    }
    if (String(url).endsWith("/clear")) {
      operations.push("clear")
      return new Response(null, { status: 200 })
    }
    throw new Error(`unexpected request: ${options.method ?? "GET"} ${url}`)
  }

  const hooks = await NtfyPlugin(input, {
    topic: "test-topic",
    server: "https://ntfy.example.com",
  })

  try {
    const idle = hooks.event({
      event: { type: "session.idle", properties: { sessionID: "session-id" } },
    })
    await publishStarted
    const disposal = hooks.dispose()
    resolvePublish()
    await Promise.all([idle, disposal])

    assert.deepEqual(operations, ["publish started", "publish finished", "clear"])
  } finally {
    await hooks.dispose()
    globalThis.fetch = originalFetch
  }
})

test("permission requests publish and clear a notification", { timeout: 1000 }, async () => {
  const originalFetch = globalThis.fetch
  const published = []
  const cleared = []

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/clear")) {
      cleared.push(String(url))
      return new Response(null, { status: 200 })
    }
    if (options.method === "POST") {
      published.push(JSON.parse(options.body))
      return new Response(null, { status: 200 })
    }
    throw new Error(`unexpected request: ${options.method ?? "GET"} ${url}`)
  }

  const hooks = await NtfyPlugin(input, {
    topic: "test-topic",
    server: "https://ntfy.example.com",
    hideChatContent: false,
  })

  try {
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "permission-id",
          sessionID: "session-id",
          permission: "external_directory",
          patterns: ["/tmp/other-project/**"],
        },
      },
    })

    assert.equal(published.length, 1)
    assert.equal(published[0].title, "Test session")
    assert.equal(published[0].message, "OpenCode needs permission.")
    assert.equal(published[0].priority, 4)
    assert.deepEqual(published[0].tags, ["warning"])
    assert.equal(published[0].sequence_id, "opencode-permission-permission-id")

    await hooks.event({
      event: {
        type: "permission.replied",
        properties: {
          sessionID: "session-id",
          requestID: "permission-id",
          reply: "once",
        },
      },
    })

    assert.deepEqual(cleared, [
      "https://ntfy.example.com/test-topic/opencode-permission-permission-id/clear",
    ])
  } finally {
    await hooks.dispose()
    globalThis.fetch = originalFetch
  }
})

test("auto-approved permission requests never publish a notification", { timeout: 1000 }, async () => {
  const originalFetch = globalThis.fetch
  const published = []
  const cleared = []

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/clear")) {
      cleared.push(String(url))
      return new Response(null, { status: 200 })
    }
    if (options.method === "POST") {
      published.push(JSON.parse(options.body))
      return new Response(null, { status: 200 })
    }
    throw new Error(`unexpected request: ${options.method ?? "GET"} ${url}`)
  }

  const hooks = await NtfyPlugin(input, {
    topic: "test-topic",
    server: "https://ntfy.example.com",
  })

  try {
    const asked = hooks.event({
      event: {
        type: "permission.asked",
        properties: { id: "permission-id", sessionID: "session-id" },
      },
    })
    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "session-id", requestID: "permission-id", reply: "once" },
      },
    })
    await asked

    assert.deepEqual(published, [])
    assert.deepEqual(cleared, [])
  } finally {
    await hooks.dispose()
    globalThis.fetch = originalFetch
  }
})

test("chat content is hidden by default while notification types are preserved", { timeout: 1000 }, async () => {
  const originalFetch = globalThis.fetch
  const published = []
  let resolvePermissionPublished
  const permissionPublished = new Promise((resolve) => {
    resolvePermissionPublished = resolve
  })
  const privateInput = {
    client: {
      session: {
        get: async () => ({ data: { title: "Secret session name" } }),
      },
    },
    directory: input.directory,
  }

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/clear")) return new Response(null, { status: 200 })
    if (options.method === "POST") {
      const body = JSON.parse(options.body)
      published.push(body)
      if (body.tags?.includes("warning")) resolvePermissionPublished()
      return new Response(null, { status: 200 })
    }
    throw new Error(`unexpected request: ${options.method ?? "GET"} ${url}`)
  }

  const hooks = await NtfyPlugin(privateInput, {
    topic: "test-topic",
    server: "https://ntfy.example.com",
  })

  try {
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: { id: "permission-id", sessionID: "session-id" },
      },
    })
    await permissionPublished
    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "session-id", requestID: "permission-id" },
      },
    })
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "session-id" } },
    })
    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "question-id",
          sessionID: "session-id",
          questions: [
            {
              header: "Secret question header",
              question: "Secret question text",
              options: [{ label: "Secret answer", description: "Secret answer description" }],
            },
          ],
        },
      },
    })

    const question = published.find((body) => body.tags?.includes("question"))
    const permission = published.find((body) => body.tags?.includes("warning"))
    const completion = published.find((body) => body.tags?.includes("heavy_check_mark"))
    assert.equal(permission.title, "OpenCode")
    assert.equal(permission.message, "OpenCode needs permission.")
    assert.equal(completion.title, "OpenCode")
    assert.equal(completion.message, "OpenCode response finished.")
    assert.equal(question.title, "OpenCode")
    assert.equal(question.message, "OpenCode has a question.")
    assert.equal("actions" in question, false)

    const outbound = JSON.stringify(published)
    for (const secret of [
      "Secret session name",
      "Secret question header",
      "Secret question text",
      "Secret answer",
      "Secret answer description",
    ]) {
      assert.equal(outbound.includes(secret), false)
    }
  } finally {
    await hooks.dispose()
    globalThis.fetch = originalFetch
  }
})

test("question rejection clears its notification", { timeout: 1000 }, async () => {
  const originalFetch = globalThis.fetch
  let resolvePayload
  let resolveClear
  const payload = new Promise((resolve) => {
    resolvePayload = resolve
  })
  const cleared = new Promise((resolve) => {
    resolveClear = resolve
  })

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/clear")) {
      resolveClear(String(url))
      return new Response(null, { status: 200 })
    }

    const body = JSON.parse(options.body)
    resolvePayload(body)
    return new Response(null, { status: 200 })
  }

  const hooks = await NtfyPlugin(input, {
    topic: "test-topic",
    server: "https://ntfy.example.com",
  })

  try {
    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "request-id",
          sessionID: "session-id",
          questions: [
            {
              header: "Deploy?",
              question: "Choose an action",
              options: [{ label: "Yes", description: "Deploy now" }],
            },
          ],
        },
      },
    })
    const notification = await payload
    await hooks.event({
      event: { type: "question.rejected", properties: { requestID: "request-id" } },
    })

    assert.equal(
      await cleared,
      `https://ntfy.example.com/test-topic/${notification.sequence_id}/clear`,
    )
  } finally {
    await hooks.dispose()
    globalThis.fetch = originalFetch
  }
})

test("rejected question cannot publish after its session lookup resolves", { timeout: 1000 }, async () => {
  const originalFetch = globalThis.fetch
  let publishCount = 0
  let clearCount = 0
  let resolveSessionLookupStarted
  let resolveSessionLookup
  const sessionLookupStarted = new Promise((resolve) => {
    resolveSessionLookupStarted = resolve
  })
  const sessionLookup = new Promise((resolve) => {
    resolveSessionLookup = resolve
  })
  const delayedInput = {
    client: {
      session: {
        get: async () => {
          resolveSessionLookupStarted()
          return sessionLookup
        },
      },
    },
    directory: input.directory,
  }

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/clear")) {
      clearCount += 1
      return new Response(null, { status: 200 })
    }
    if (options.method === "POST") {
      publishCount += 1
      return new Response(null, { status: 200 })
    }
    throw new Error(`unexpected request: ${options.method ?? "GET"} ${url}`)
  }

  const hooks = await NtfyPlugin(delayedInput, {
    topic: "test-topic",
    server: "https://ntfy.example.com",
  })

  try {
    const questionAsked = hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "request-id",
          sessionID: "session-id",
          questions: [
            {
              header: "Deploy?",
              question: "Choose an action",
              options: [{ label: "Yes", description: "Deploy now" }],
            },
          ],
        },
      },
    })
    await sessionLookupStarted
    await hooks.event({
      event: { type: "question.rejected", properties: { requestID: "request-id" } },
    })
    resolveSessionLookup({ data: { title: "Test session" } })
    await questionAsked

    assert.equal(publishCount, 0)
    assert.equal(clearCount, 0)
  } finally {
    await hooks.dispose()
    globalThis.fetch = originalFetch
  }
})
