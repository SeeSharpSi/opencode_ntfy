export type DeliveryPolicy = {
  requestTimeoutMs: number
  retryAttempts: number
  retryDelayMs: number
}

export class NtfyHttpError extends Error {
  readonly status: number
  readonly retryAfterMs?: number

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message)
    this.name = "NtfyHttpError"
    this.status = status
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

export class TimeoutError extends Error {
  constructor(action: string, timeoutMs: number) {
    super(`${action} failed: request timed out after ${timeoutMs}ms`)
    this.name = "TimeoutError"
  }
}

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504])
const maximumSleepMs = 30_000
const maximumTimerMs = 2_147_483_647

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason === undefined ? new DOMException("Aborted", "AbortError") : signal.reason

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortReason(signal)
}

export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      action()
    }

    const onAbort = () => {
      settle(() => reject(abortReason(signal as AbortSignal)))
    }

    timer = setTimeout(() => {
      settle(resolve)
    }, Math.max(0, ms))

    signal?.addEventListener("abort", onAbort, { once: true })
    // The signal may have aborted between the initial check and listener setup.
    if (signal?.aborted) onAbort()
  })
}

const oneLine = (value: unknown, limit = 120) =>
  String(value).replace(/\s+/g, " ").trim().slice(0, limit)

const failureHint = (status: number) => {
  if (status === 401 || status === 403) {
    return "Hint: set NTFY_TOKEN or username/password; check topic permissions."
  }
  if (status === 429) return "Hint: ntfy rate limit reached; retry later."
  return ""
}

const parseRetryAfter = (value: string | null): number | undefined => {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined
  }
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

// Keep a rejection observed even when a race is settled by timeout or abort.
const observe = <T>(promise: Promise<T>): Promise<T> => {
  void promise.catch(() => {})
  return promise
}

const retryableNetworkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ConnectionRefused",
  "ConnectionClosed",
  "ConnectionReset",
  "SocketClosed",
])

// Inspect a short cause chain for well-known fetch transport failures.
const isRetryableNetworkError = (error: Error): boolean => {
  const seen = new Set<Error>()
  let current: unknown = error

  for (let depth = 0; depth < 3; depth++) {
    if (!(current instanceof Error) || seen.has(current)) return false
    seen.add(current)

    if (current.name === "AbortError") return false
    if (current.name === "NetworkError") return true
    if (retryableNetworkCodes.has(current.name)) return true
    if (/fetch failed|network error|failed to fetch/i.test(current.message)) return true

    const code = (current as Error & { code?: unknown }).code
    if (typeof code === "string" && retryableNetworkCodes.has(code)) return true

    current = (current as Error & { cause?: unknown }).cause
  }

  return false
}

const errorStatus = (error: unknown): number | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = error

  for (let depth = 0; depth < 3; depth++) {
    if (typeof current !== "object" || current === null) return undefined
    if (seen.has(current)) return undefined
    seen.add(current)

    const record = current as {
      status?: unknown
      statusCode?: unknown
      response?: unknown
      cause?: unknown
    }
    if (typeof record.status === "number") return record.status
    if (typeof record.statusCode === "number") return record.statusCode
    if (typeof record.response === "object" && record.response !== null) {
      const status = (record.response as { status?: unknown }).status
      if (typeof status === "number") return status
    }

    current = record.cause
  }

  return undefined
}

export const isRetryableError = (error: unknown) => {
  if (error instanceof Error && error.name === "AbortError") return false
  if (error instanceof NtfyHttpError) return retryableStatuses.has(error.status)
  const status = errorStatus(error)
  if (status !== undefined) return retryableStatuses.has(status)
  if (error instanceof TimeoutError) return true
  if (error instanceof TypeError) return true
  return error instanceof Error && isRetryableNetworkError(error)
}

const boundedTimeout = (value: number) => {
  const finite = Number.isFinite(value) ? value : 0
  return Math.min(maximumTimerMs, Math.max(1, Math.floor(finite)))
}

type AttemptContext = {
  url: string
  init: RequestInit
  action: string
  policy: DeliveryPolicy
  signal?: AbortSignal
}

const httpError = (action: string, response: Response, body: string): NtfyHttpError => {
  let errorText = oneLine(body)
  let code: number | undefined
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown }
    if (typeof parsed.error === "string") errorText = oneLine(parsed.error)
    if (typeof parsed.code === "number") code = parsed.code
  } catch {
    // Use the bounded response text for non-JSON ntfy errors.
  }
  const codeText = code === undefined ? "" : `, ntfy code ${code}`
  const hint = failureHint(response.status)
  const message = `${action} failed: HTTP ${response.status}${codeText}: ${
    errorText || "request failed"
  }${hint ? ` ${hint}` : ""}`
  const retryAfterHeader =
    typeof response.headers?.get === "function"
      ? response.headers.get("retry-after")
      : null
  const retryAfterMs = parseRetryAfter(retryAfterHeader)
  return new NtfyHttpError(message, response.status, retryAfterMs)
}

const attempt = async ({
  url,
  init,
  action,
  policy,
  signal,
}: AttemptContext): Promise<void> => {
  throwIfAborted(signal)

  const timeoutMs = boundedTimeout(policy.requestTimeoutMs)
  const controller = new AbortController()
  const timeoutError = new TimeoutError(action, timeoutMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectStop: ((reason: unknown) => void) | undefined

  // Explicit race stop so timeout and caller abort win even if fetch ignores signals.
  const stop = new Promise<never>((_, reject) => {
    rejectStop = reject
  })
  void stop.catch(() => {})

  const onAbort = () => {
    const reason = abortReason(signal as AbortSignal)
    controller.abort(reason)
    rejectStop?.(reason)
  }

  timer = setTimeout(() => {
    controller.abort(timeoutError)
    rejectStop?.(timeoutError)
  }, timeoutMs)
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    throwIfAborted(signal)
    const sent = observe(fetch(url, { ...init, signal: controller.signal }))
    const response = await Promise.race([sent, stop])

    if (!response.ok) {
      const body = await Promise.race([observe(response.text()), stop])
      throw httpError(action, response, body)
    }

    // Consume the body before resolving and keep the attempt timeout active.
    await Promise.race([observe(response.text()), stop])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

export async function request(
  url: string,
  init: RequestInit,
  action: string,
  policy: DeliveryPolicy,
  signal?: AbortSignal,
): Promise<void> {
  const attempts = Number.isFinite(policy.retryAttempts)
    ? Math.max(1, Math.floor(policy.retryAttempts))
    : 1
  let lastError: unknown

  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex++) {
    throwIfAborted(signal)

    try {
      await attempt({ url, init, action, policy, signal })
      return
    } catch (error) {
      throwIfAborted(signal)
      lastError = error

      if (attemptIndex + 1 >= attempts || !isRetryableError(error)) throw error

      const baseDelay = Number.isFinite(policy.retryDelayMs)
        ? Math.max(0, policy.retryDelayMs)
        : 0
      let delay = baseDelay * 2 ** attemptIndex
      if (error instanceof NtfyHttpError && error.retryAfterMs !== undefined) {
        delay = Math.max(delay, error.retryAfterMs)
      }

      // Never sleep longer than the cap. A server-requested delay above the cap
      // must fail instead of retrying earlier than Retry-After allows.
      if (!Number.isFinite(delay) || delay > maximumSleepMs) throw error

      await wait(delay, signal)
    }
  }

  throw lastError
}
