import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"

import { createNtfyRuntime } from "./index.ts"

const LOOPBACK = "127.0.0.1"

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.once("error", reject)
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject)
      const { port } = server.address()
      resolve({ server, url: `http://${LOOPBACK}:${port}` })
    })
  })
}

function close(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

test("rejects authenticated redirects when publishing a form notification", { timeout: 10000 }, async () => {
  const posts = []
  const clears = []
  const targetRequests = []
  const originalConsoleError = console.error
  let first
  let target
  let runtime

  try {
    target = await listen((request, response) => {
      targetRequests.push(request.url)
      request.resume()
      request.on("end", () => {
        response.writeHead(200)
        response.end()
      })
    })

    first = await listen((request, response) => {
      request.resume()
      request.on("end", () => {
        if (request.method === "POST") {
          posts.push({
            url: request.url,
            authorization: request.headers.authorization
          })
          response.writeHead(307, { location: `${target.url}/redirect-target` })
          response.end()
          return
        }

        clears.push(request.url)
        response.writeHead(200)
        response.end()
      })
    })

    runtime = await createNtfyRuntime({
      options: {
        topic: "redirect-security-topic",
        server: first.url,
        token: "synthetic-test-token",
        allowInsecureHttp: true,
        requestTimeoutMs: 500,
        retryAttempts: 1
      },
      session: {
        get: async () => ({ sessionID: "redirect-session", title: "Question" })
      }
    })

    console.error = () => {}

    await runtime.handleEvent({
      type: "form.created",
      data: {
        form: {
          id: "redirect-question",
          sessionID: "redirect-session",
          title: "Question",
          fields: []
        }
      }
    })

    await runtime.dispose()
    runtime = undefined

    assert.equal(posts.length, 1)
    assert.equal(posts[0].authorization, "Bearer synthetic-test-token")
    assert.deepEqual(targetRequests, [])
    assert.ok(clears.length > 0, "expected a clear request during dispose")
    assert.match(clears[0], /redirect-security-topic/)
  } finally {
    console.error = originalConsoleError
    if (runtime) await runtime.dispose().catch(() => {})
    await Promise.allSettled([close(first?.server), close(target?.server)])
  }
})
