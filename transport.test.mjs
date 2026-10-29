import assert from "node:assert/strict"
import test from "node:test"

import { request, wait, NtfyHttpError } from "./transport.ts"

const url = "https://ntfy.example.com/test-topic"
const init = { method: "POST" }
const action = "ntfy publish"

const makePolicy = (overrides = {}) => ({
  requestTimeoutMs: 50,
  retryAttempts: 3,
  retryDelayMs: 1,
  ...overrides,
})

const withMockFetch = async (mock, run) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

const rejectionOf = (promise) =>
  promise.then(
    () => assert.fail("expected request to reject"),
    (error) => error,
  )

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("transient 503 is retried and the next success resolves", { timeout: 1000 }, async () => {
  let calls = 0

  await withMockFetch(
    async () => {
      calls += 1
      if (calls === 1) return new Response("unavailable", { status: 503 })
      return new Response(null, { status: 200 })
    },
    async () => {
      await request(url, init, action, makePolicy())
    },
  )

  assert.equal(calls, 2)
})

test("network TypeError is retried and the next success resolves", { timeout: 1000 }, async () => {
  let calls = 0

  await withMockFetch(
    async () => {
      calls += 1
      if (calls === 1) throw new TypeError("fetch failed")
      return new Response(null, { status: 200 })
    },
    async () => {
      await request(url, init, action, makePolicy())
    },
  )

  assert.equal(calls, 2)
})

test("403 is not retried and reports ntfy code and auth hint", { timeout: 1000 }, async () => {
  let calls = 0

  const error = await withMockFetch(
    async () => {
      calls += 1
      return new Response(JSON.stringify({ code: 40301, error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    },
    () => rejectionOf(request(url, init, action, makePolicy())),
  )

  assert.equal(calls, 1)
  assert.ok(error instanceof NtfyHttpError)
  assert.equal(
    error.message,
    "ntfy publish failed: HTTP 403, ntfy code 40301: forbidden " +
      "Hint: set NTFY_TOKEN or username/password; check topic permissions.",
  )
})

test("400, 401, and 404 are never retried", { timeout: 1000 }, async () => {
  for (const status of [400, 401, 404]) {
    let calls = 0
    const error = await withMockFetch(
      async () => {
        calls += 1
        return new Response("rejected", { status })
      },
      () => rejectionOf(request(url, init, action, makePolicy())),
    )

    assert.equal(calls, 1, `status ${status} must not be retried`)
    assert.ok(error instanceof NtfyHttpError)
    assert.match(error.message, new RegExp(`HTTP ${status}`))
  }
})

test("timed out fetch is released and the retry succeeds", { timeout: 1000 }, async () => {
  let calls = 0

  await withMockFetch(
    async () => {
      calls += 1
      if (calls === 1) return new Promise(() => {})
      return new Response(null, { status: 200 })
    },
    async () => {
      await request(
        url,
        init,
        action,
        makePolicy({ requestTimeoutMs: 20, retryAttempts: 3, retryDelayMs: 1 }),
      )
    },
  )

  assert.equal(calls, 2)
})

test("stalled response body is bounded by the request timeout", { timeout: 1000 }, async () => {
  let calls = 0
  const stalledResponse = () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => new Promise(() => {}),
  })

  const error = await withMockFetch(
    async () => {
      calls += 1
      return stalledResponse()
    },
    () =>
      rejectionOf(
        request(
          url,
          init,
          action,
          makePolicy({ requestTimeoutMs: 20, retryAttempts: 2, retryDelayMs: 1 }),
        ),
      ),
  )

  assert.equal(calls, 2)
  assert.equal(error.name, "TimeoutError")
})

test("aborting during retry backoff stops further fetches", { timeout: 1000 }, async () => {
  const controller = new AbortController()
  let calls = 0
  let resolveStarted
  const started = new Promise((resolve) => {
    resolveStarted = resolve
  })

  await withMockFetch(
    async () => {
      calls += 1
      resolveStarted()
      return new Response("unavailable", { status: 503 })
    },
    async () => {
      const pending = request(
        url,
        init,
        action,
        makePolicy({ requestTimeoutMs: 100, retryAttempts: 5, retryDelayMs: 200 }),
        controller.signal,
      )
      await started
      await delay(20)
      controller.abort()
      const error = await rejectionOf(pending)
      assert.equal(error.name, "AbortError")
    },
  )

  await delay(30)
  assert.equal(calls, 1)
})

test("an already aborted caller signal sends no request", { timeout: 1000 }, async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0

  const error = await withMockFetch(
    async () => {
      calls += 1
      return new Response(null, { status: 200 })
    },
    () => rejectionOf(request(url, init, action, makePolicy(), controller.signal)),
  )

  assert.equal(calls, 0)
  assert.equal(error.name, "AbortError")
})

test("Retry-After longer than 30 seconds fails without retrying", { timeout: 1000 }, async () => {
  let calls = 0
  const started = Date.now()

  const error = await withMockFetch(
    async () => {
      calls += 1
      return new Response("unavailable", {
        status: 503,
        headers: { "Retry-After": "31" },
      })
    },
    () => rejectionOf(request(url, init, action, makePolicy({ retryDelayMs: 1 }))),
  )

  const elapsed = Date.now() - started
  assert.equal(calls, 1)
  assert.ok(error instanceof NtfyHttpError)
  assert.match(error.message, /HTTP 503/)
  assert.ok(elapsed < 500, `waited ${elapsed}ms instead of failing fast`)
})

test("short numeric Retry-After is respected over a smaller backoff", { timeout: 1000 }, async () => {
  let calls = 0
  const started = Date.now()

  await withMockFetch(
    async () => {
      calls += 1
      if (calls === 1) {
        return new Response("unavailable", {
          status: 503,
          headers: { "Retry-After": "0.05" },
        })
      }
      return new Response(null, { status: 200 })
    },
    async () => {
      await request(
        url,
        init,
        action,
        makePolicy({ requestTimeoutMs: 100, retryAttempts: 3, retryDelayMs: 1 }),
      )
    },
  )

  const elapsed = Date.now() - started
  assert.equal(calls, 2)
  assert.ok(elapsed >= 30, `retried after ${elapsed}ms, expected Retry-After delay`)
})

test("successful response bodies are consumed", { timeout: 1000 }, async () => {
  let response

  await withMockFetch(
    async () => {
      response = new Response("ok", { status: 200 })
      return response
    },
    async () => {
      await request(url, init, action, makePolicy())
    },
  )

  assert.equal(response.bodyUsed, true)
})

test("wait resolves after its delay and clears its timer", { timeout: 1000 }, async () => {
  const started = Date.now()
  await wait(20)
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 10, `resolved after ${elapsed}ms, expected at least 10ms`)
})

test("wait rejects on abort instead of sleeping", { timeout: 1000 }, async () => {
  const controller = new AbortController()
  const started = Date.now()
  const pending = wait(10_000, controller.signal)
  const rejected = rejectionOf(pending)

  controller.abort()
  const error = await rejected

  assert.equal(error.name, "AbortError")
  assert.ok(Date.now() - started < 200, "abort should reject without waiting for the timer")
})

test("wait rejects immediately for an already aborted signal", { timeout: 1000 }, async () => {
  const controller = new AbortController()
  controller.abort()

  const error = await rejectionOf(wait(10_000, controller.signal))
  assert.equal(error.name, "AbortError")
})

test("HTTP-date Retry-After is respected", { timeout: 1000 }, async () => {
  const originalNow = Date.now
  const retryAt = "Wed, 21 Oct 2015 07:28:00 GMT"
  const parsedRetryAt = Date.parse(retryAt)
  let calls = 0
  let elapsed = 0

  Date.now = () => parsedRetryAt - 40
  try {
    const started = performance.now()
    await withMockFetch(
      async () => {
        calls += 1
        if (calls === 1) {
          return new Response("unavailable", {
            status: 503,
            headers: { "Retry-After": retryAt },
          })
        }
        return new Response(null, { status: 200 })
      },
      async () => {
        await request(
          url,
          init,
          action,
          makePolicy({ requestTimeoutMs: 100, retryAttempts: 2, retryDelayMs: 0 }),
        )
      },
    )
    elapsed = performance.now() - started
  } finally {
    Date.now = originalNow
  }

  assert.equal(calls, 2)
  assert.ok(elapsed >= 30, `retried after ${elapsed}ms, expected Retry-After delay`)
})

test("retryAttempts caps persistent network failures", { timeout: 1000 }, async () => {
  let calls = 0

  const error = await withMockFetch(
    async () => {
      calls += 1
      throw new TypeError("fetch failed")
    },
    () =>
      rejectionOf(
        request(
          url,
          init,
          action,
          makePolicy({ requestTimeoutMs: 20, retryAttempts: 3, retryDelayMs: 0 }),
        ),
      ),
  )

  assert.equal(calls, 3)
  assert.ok(error instanceof TypeError)
})

test("ordinary Error with ECONNRESET code is retried", { timeout: 1000 }, async () => {
  let calls = 0

  await withMockFetch(
    async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error("socket closed")
        error.code = "ECONNRESET"
        throw error
      }
      return new Response(null, { status: 200 })
    },
    async () => {
      await request(
        url,
        init,
        action,
        makePolicy({ requestTimeoutMs: 20, retryAttempts: 2, retryDelayMs: 0 }),
      )
    },
  )

  assert.equal(calls, 2)
})

test("nested Error cause with UND_ERR_SOCKET is retried", { timeout: 1000 }, async () => {
  let calls = 0

  await withMockFetch(
    async () => {
      calls += 1
      if (calls === 1) {
        const cause = new Error("socket closed")
        cause.code = "UND_ERR_SOCKET"
        throw new Error("request terminated", { cause })
      }
      return new Response(null, { status: 200 })
    },
    async () => {
      await request(
        url,
        init,
        action,
        makePolicy({ requestTimeoutMs: 20, retryAttempts: 2, retryDelayMs: 0 }),
      )
    },
  )

  assert.equal(calls, 2)
})

test("ordinary non-network Error is not retried", { timeout: 1000 }, async () => {
  let calls = 0
  const originalError = new Error("unexpected payload")

  const error = await withMockFetch(
    async () => {
      calls += 1
      throw originalError
    },
    () =>
      rejectionOf(
        request(
          url,
          init,
          action,
          makePolicy({ requestTimeoutMs: 20, retryAttempts: 3, retryDelayMs: 0 }),
        ),
      ),
  )

  assert.equal(calls, 1)
  assert.equal(error, originalError)
})

test("AbortError stays non-retryable even with a network-like message", { timeout: 1000 }, async () => {
  let calls = 0
  const abortError = new Error("fetch failed network error")
  abortError.name = "AbortError"

  const error = await withMockFetch(
    async () => {
      calls += 1
      throw abortError
    },
    () =>
      rejectionOf(
        request(
          url,
          init,
          action,
          makePolicy({ requestTimeoutMs: 20, retryAttempts: 3, retryDelayMs: 0 }),
        ),
      ),
  )

  assert.equal(calls, 1)
  assert.equal(error, abortError)
})

test("retryable statuses are retried", { timeout: 1000 }, async () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    let calls = 0

    await withMockFetch(
      async () => {
        calls += 1
        if (calls === 1) return new Response("retry", { status })
        return new Response(null, { status: 200 })
      },
      async () => {
        await request(
          url,
          init,
          action,
          makePolicy({ requestTimeoutMs: 20, retryAttempts: 2, retryDelayMs: 0 }),
        )
      },
    )

    assert.equal(calls, 2, `status ${status} should be retried`)
  }
})

test("non-retryable statuses fail on the first attempt", { timeout: 1000 }, async () => {
  for (const status of [501, 505]) {
    let calls = 0

    const error = await withMockFetch(
      async () => {
        calls += 1
        return new Response("fatal", { status })
      },
      () =>
        rejectionOf(
          request(
            url,
            init,
            action,
            makePolicy({ requestTimeoutMs: 20, retryAttempts: 3, retryDelayMs: 0 }),
          ),
        ),
    )

    assert.equal(calls, 1, `status ${status} must not be retried`)
    assert.ok(error instanceof NtfyHttpError)
    assert.equal(error.status, status)
  }
})

test("aborting stops a stalled response body", { timeout: 1000 }, async () => {
  const controller = new AbortController()
  let calls = 0

  const error = await withMockFetch(
    async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => new Promise(() => {}),
      }
    },
    async () => {
      const pending = request(
        url,
        init,
        action,
        makePolicy({ requestTimeoutMs: 500, retryAttempts: 3, retryDelayMs: 0 }),
        controller.signal,
      )
      await delay(10)
      controller.abort()
      return rejectionOf(pending)
    },
  )

  assert.equal(calls, 1)
  assert.equal(error.name, "AbortError")
})

test("request timeout aborts the underlying fetch signal", { timeout: 1000 }, async () => {
  let calls = 0
  let fetchSignal

  const error = await withMockFetch(
    async (_url, options = {}) => {
      calls += 1
      fetchSignal = options.signal
      return new Promise(() => {})
    },
    () =>
      rejectionOf(
        request(
          url,
          init,
          action,
          makePolicy({ requestTimeoutMs: 20, retryAttempts: 1, retryDelayMs: 0 }),
        ),
      ),
  )

  assert.equal(calls, 1)
  assert.equal(error.name, "TimeoutError")
  assert.ok(fetchSignal)
  assert.equal(fetchSignal.aborted, true)
})
