import type {
  FeedbackPayload,
  FeedbackResponse,
  SubmissionSessionResponse,
  ClarifyResponse,
  ClarifyMessage,
  ReporterDetails,
} from '../types'
import { filterSensitiveText } from '../privacy/sanitize'

export interface ClarifyStreamResult {
  messages: ClarifyMessage[]
  suggestions?: string[]
  done: boolean
  failed?: boolean
}

// Carries the HTTP status so callers can tell a retryable failure from a terminal
// one (e.g. 409 = the submission session is no longer accepting a finalize, which
// retrying can never fix). The message stays `HTTP <status>` for compatibility.
export class ApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
  }
}

export type UploadErrorCode =
  | 'upload_too_large'
  | 'too_many_uploads'
  | 'unsupported_image_type'
  | 'capture_policy_required'
  | 'session_inactive'
  | 'unknown'

/**
 * The server refused a reporter image for a reason sending the same bytes again
 * cannot fix (413 too large, 422 rule violation, 404 session no longer active).
 * Network failures and 5xx stay plain errors / ApiError: those are worth a retry.
 */
export class UploadRejectedError extends ApiError {
  readonly code: UploadErrorCode
  /** From a 413: the server's per-file ceiling. */
  readonly maxBytes?: number

  constructor(status: number, code: UploadErrorCode, maxBytes?: number) {
    super(status)
    this.name = 'UploadRejectedError'
    this.code = code
    this.maxBytes = maxBytes
  }
}

export interface UploadedImage {
  id: string
  content_type: string
  size: number
}

const UPLOAD_ERROR_CODES: ReadonlySet<string> = new Set([
  'upload_too_large',
  'too_many_uploads',
  'unsupported_image_type',
  'capture_policy_required',
])

export function isTerminalConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409
}

// A finalize the reporter can no longer watch must still end. Without a ceiling
// a request that never settles leaves the widget mid-submission forever, with
// the launcher inert and nothing on screen to explain why.
export const FINALIZE_TIMEOUT_MS = 25_000

export const DEFAULT_API_URL = 'https://testmate.beansmile.ai/api/v1'
const CAPTURE_POLICY = 'sensitive-data-v1'

export interface ApiClientOptions {
  projectKey: string
  apiUrl?: string
  retryDelayMs?: number
  userToken?: string
  userTokenFn?: () => Promise<string>
}

export class ApiClient {
  private apiUrl: string
  private projectKey: string
  private retryDelayMs: number
  private userToken?: string
  private userTokenFn?: () => Promise<string>

  constructor(options: ApiClientOptions) {
    this.projectKey = options.projectKey
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, '')
    this.retryDelayMs = options.retryDelayMs ?? 1000
    this.userToken = options.userToken
    this.userTokenFn = options.userTokenFn
  }

  async resolveUserToken(): Promise<string | undefined> {
    if (this.userTokenFn) return this.userTokenFn()
    return this.userToken
  }

  async resolveScreenshotResourceUrl(
    submissionSessionId: string,
    token: string,
    resourceUrl: string,
    contentType?: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (contentType && !contentType.startsWith('image/')) return undefined

    try {
      const source = new URL(resourceUrl, window.location.href)
      if (!['http:', 'https:'].includes(source.protocol)) return undefined
      if (source.origin === window.location.origin) return undefined

      const headers = await this.submissionHeaders(token, 'application/json')
      const res = await this.fetchWithRetry(
        `${this.apiUrl}/widget/feedback_submission_sessions/${submissionSessionId}/image_proxy_url`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ image_proxy_url: { source: source.href } }),
          signal,
        },
      )
      const body = await res.json() as { url?: unknown }
      return typeof body.url === 'string' ? body.url : undefined
    } catch {
      return undefined
    }
  }

  private async authHeaders(contentType?: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'X-Project-Key': this.projectKey }
    const token = await this.resolveUserToken()
    if (token) headers['X-User-Token'] = token
    if (contentType) headers['Content-Type'] = contentType
    return headers
  }

  private async submissionHeaders(token: string, contentType?: string): Promise<Record<string, string>> {
    const headers = await this.authHeaders(contentType)
    headers['X-Submission-Token'] = token
    return headers
  }

  async createSubmissionSession(payload: FeedbackPayload, screenshot: Blob | null): Promise<SubmissionSessionResponse> {
    const submissionToken = generateSubmissionToken()
    const form = new FormData()
    form.append('feedback[description]', payload.description)
    form.append('feedback[page_url]', payload.page_url)
    form.append('feedback[user_agent]', payload.user_agent)
    form.append('feedback[browser]', payload.browser)
    form.append('feedback[os]', payload.os)
    form.append('feedback[screen_width]', String(payload.screen_width))
    form.append('feedback[screen_height]', String(payload.screen_height))
    form.append('feedback[console_errors]', JSON.stringify(payload.console_errors))
    form.append('feedback[annotations]', JSON.stringify(payload.annotations))

    if (payload.target_element) {
      form.append('feedback[target_element]', JSON.stringify(payload.target_element))
    }
    if (payload.user_id) form.append('feedback[user_id]', payload.user_id)
    if (payload.reporter_external_id) form.append('feedback[reporter_external_id]', payload.reporter_external_id)
    if (payload.reporter_email) form.append('feedback[reporter_email]', payload.reporter_email)
    if (payload.reporter_name) form.append('feedback[reporter_name]', payload.reporter_name)
    if (payload.user_email) form.append('feedback[user_email]', payload.user_email)
    if (payload.user_name) form.append('feedback[user_name]', payload.user_name)

    if (payload.breadcrumbs && payload.breadcrumbs.length > 0) {
      form.append('feedback[breadcrumbs]', JSON.stringify(payload.breadcrumbs))
    }

    if (payload.metadata && Object.keys(payload.metadata).length > 0) {
      form.append('feedback[metadata]', JSON.stringify(payload.metadata))
    }

    if (payload.recording_events && payload.recording_events.length > 0) {
      const json = JSON.stringify(payload.recording_events)
      const blob = new Blob([json], { type: 'application/json' })
      form.append('feedback[recording]', blob, 'interaction-replay.json')
      form.append('feedback[recording_duration]', String(payload.recording_duration ?? 0))
    }

    if (screenshot) {
      const ext = screenshot.type === 'image/jpeg' ? 'jpg' : 'png'
      form.append('feedback[screenshot]', screenshot, `screenshot.${ext}`)
    }

    const headers = await this.authHeaders()
    headers['X-Submission-Token'] = submissionToken
    headers['X-MTB-Capture-Policy'] = CAPTURE_POLICY
    // One key per submission, reused across retries: if the first POST
    // reached the server but the response was lost, the retry must not
    // create a second feedback.
    headers['X-Idempotency-Key'] = generateIdempotencyKey()
    const res = await this.fetchWithRetry(`${this.apiUrl}/widget/feedback_submission_sessions`, {
      method: 'POST',
      headers,
      body: form,
    })
    const body = await res.json() as {
      submission_session: Omit<SubmissionSessionResponse, 'token'> & { token?: string }
    }
    return { ...body.submission_session, token: submissionToken }
  }

  async createIdentityToken(reporterExternalId: string): Promise<{ identity_token: string; board_url: string } | null> {
    const headers = await this.authHeaders('application/json')
    try {
      const res = await this.fetchWithRetry(`${this.apiUrl}/widget/identity_tokens`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ reporter_external_id: reporterExternalId }),
      })
      return await res.json()
    } catch {
      return null
    }
  }

  // Sends only the fields the reporter filled in: the server keeps anything
  // already set, so an omitted field is "no change", never "clear it".
  async updateReporter(feedbackId: string, details: ReporterDetails, identityToken: string): Promise<boolean> {
    const reporter: ReporterDetails = {}
    const email = details.email?.trim()
    const name = details.name?.trim()
    if (email) reporter.email = email
    if (name) reporter.name = name
    if (!reporter.email && !reporter.name) return false
    const headers = await this.authHeaders('application/json')
    headers['X-Identity-Token'] = identityToken
    try {
      await this.fetchWithRetry(`${this.apiUrl}/widget/feedbacks/${feedbackId}/reporter`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ reporter }),
      })
      return true
    } catch {
      return false
    }
  }

  // Records the reporter's answer to the AI follow-up question. Must run
  // before finalize: finalizing deactivates the session and the server then
  // rejects the answer as terminal.
  async answerClarification(submissionSessionId: string, token: string, message: string): Promise<ClarifyResponse> {
    return this.requestClarification(submissionSessionId, token, { message: filterSensitiveText(message) })
  }

  private async requestClarification(
    submissionSessionId: string,
    token: string,
    body: Record<string, string | boolean>,
  ): Promise<ClarifyResponse> {
    const headers = await this.submissionHeaders(token, 'application/json')
    const res = await this.fetchWithRetry(`${this.apiUrl}/widget/feedback_submission_sessions/${submissionSessionId}/clarification`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const response = await res.json() as { clarification: ClarifyResponse }
    return response.clarification
  }

  // Streams a clarification turn over SSE. Calls onDelta for each token and
  // resolves with the committed result.
  async streamClarification(
    submissionSessionId: string,
    token: string,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ClarifyStreamResult> {
    const headers = await this.submissionHeaders(token, 'application/json')
    headers['Accept'] = 'text/event-stream'

    const res = await fetch(`${this.apiUrl}/widget/feedback_submission_sessions/${submissionSessionId}/clarification`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal,
    })

    const contentType = res.headers.get('Content-Type') ?? ''
    if (!res.ok || !res.body || !contentType.includes('text/event-stream')) {
      throw new Error('clarify stream unavailable')
    }

    return consumeSse(res.body, onDelta)
  }

  // No X-Idempotency-Key here, unlike createSubmissionSession: the session id in
  // the path already is one. The server finalizes under a row lock and returns
  // the feedback it already created if the session is finalized, so the retry
  // fetchWithRetry makes after a 5xx cannot produce a second Feedback.
  async finalizeSubmissionSession(submissionSessionId: string, token: string): Promise<FeedbackResponse> {
    const headers = await this.submissionHeaders(token)
    const controller = new AbortController()
    // Covers both attempts, so the caller waits the ceiling once rather than
    // once per retry.
    const timer = setTimeout(() => controller.abort(), FINALIZE_TIMEOUT_MS)
    try {
      const res = await this.fetchWithRetry(`${this.apiUrl}/widget/feedback_submission_sessions/${submissionSessionId}/feedback`, {
        method: 'POST',
        headers,
        signal: controller.signal,
      })
      const response = await res.json() as { feedback: FeedbackResponse }
      return response.feedback
    } finally {
      clearTimeout(timer)
    }
  }

  async uploadScreenshot(
    submissionSessionId: string,
    token: string,
    screenshot: Blob,
    signal?: AbortSignal,
  ): Promise<void> {
    const headers = await this.submissionHeaders(token)
    delete (headers as Record<string, string>)['Content-Type']
    const body = new FormData()
    body.append('screenshot', screenshot, 'screenshot.jpg')
    await this.fetchWithRetry(`${this.apiUrl}/widget/feedback_submission_sessions/${submissionSessionId}/screenshot`, {
      method: 'PUT',
      headers,
      body,
      signal,
    })
  }

  /**
   * One reporter-attached image (not the automatic screenshot). Same headers as
   * the screenshot upload plus the capture policy the uploads endpoint insists
   * on; the original filename rides in the multipart part so the dashboard can
   * show what the reporter picked.
   */
  async uploadImage(
    submissionSessionId: string,
    token: string,
    file: Blob,
    signal?: AbortSignal,
  ): Promise<UploadedImage> {
    const headers = await this.submissionHeaders(token)
    headers['X-MTB-Capture-Policy'] = CAPTURE_POLICY
    const body = new FormData()
    body.append('image', file, uploadFilename(file))
    const res = await this.fetchResponseWithRetry(
      `${this.apiUrl}/widget/feedback_submission_sessions/${submissionSessionId}/uploads`,
      { method: 'POST', headers, body, signal },
    )
    if (res.ok) {
      const json = await res.json() as { upload: UploadedImage }
      return json.upload
    }
    if (res.status === 404) throw new UploadRejectedError(404, 'session_inactive')
    if (res.status === 413 || res.status === 422) {
      const error = await res.json().catch(() => null) as { error?: { code?: unknown; max_bytes?: unknown } } | null
      const rawCode = error?.error?.code
      const code: UploadErrorCode = typeof rawCode === 'string' && UPLOAD_ERROR_CODES.has(rawCode)
        ? rawCode as UploadErrorCode
        : res.status === 413 ? 'upload_too_large' : 'unknown'
      const maxBytes = typeof error?.error?.max_bytes === 'number' ? error.error.max_bytes : undefined
      throw new UploadRejectedError(res.status, code, maxBytes)
    }
    throw new ApiError(res.status)
  }

  async abandonSubmissionSession(submissionSessionId: string, token: string): Promise<void> {
    const headers = await this.submissionHeaders(token)
    await this.fetchWithRetry(`${this.apiUrl}/widget/feedback_submission_sessions/${submissionSessionId}`, {
      method: 'DELETE',
      headers,
    })
  }

  private async fetchWithRetry(url: string, init: RequestInit, retries = 1): Promise<Response> {
    const res = await this.fetchResponseWithRetry(url, init, retries)
    if (res.ok) return res
    throw new ApiError(res.status)
  }

  // The retry policy without the status check: network errors and 5xx are
  // retried, anything else comes back as-is so a caller can read an error body.
  private async fetchResponseWithRetry(url: string, init: RequestInit, retries = 1): Promise<Response> {
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (err) {
      // An aborted request has spent its deadline; retrying only makes the
      // caller wait out the retry delay for a second guaranteed abort.
      if (retries > 0 && !init.signal?.aborted) {
        await delay(this.retryDelayMs)
        return this.fetchResponseWithRetry(url, init, retries - 1)
      }
      throw err
    }

    if (res.status >= 500 && retries > 0) {
      await delay(this.retryDelayMs)
      return this.fetchResponseWithRetry(url, init, retries - 1)
    }
    return res
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<ClarifyStreamResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: ClarifyStreamResult | null = null

  const flush = (raw: string): void => {
    // Each SSE record is "event: <name>\n data: <json>". Parse event + data.
    const eventLine = raw.split('\n').find(l => l.startsWith('event:'))
    const dataLine = raw.split('\n').find(l => l.startsWith('data:'))
    if (!dataLine) return
    const event = eventLine?.slice(6).trim()
    const payload = JSON.parse(dataLine.slice(5).trim())
    if (event === 'delta' && typeof payload.text === 'string') {
      onDelta(payload.text)
    } else if (event === 'done') {
      result = {
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        suggestions: Array.isArray(payload.suggestions)
          ? payload.suggestions.filter((s: unknown): s is string => typeof s === 'string')
          : [],
        done: payload.done !== false,
        failed: payload.error === true,
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const record = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      try { flush(record) } catch { /* skip malformed record */ }
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) {
    try { flush(buffer) } catch { /* handled by the missing done check below */ }
  }
  if (!result) throw new Error('clarify stream ended before done')

  return result
}

const UPLOAD_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function uploadFilename(file: Blob): string {
  const name = typeof File !== 'undefined' && file instanceof File ? file.name.trim() : ''
  if (name) return name
  return `image.${UPLOAD_EXTENSIONS[file.type] ?? 'bin'}`
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function generateSubmissionToken(): string {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Secure random generation is unavailable')
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
