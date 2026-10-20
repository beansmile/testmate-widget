const MOCK_API_PATH = '/__mtb_mock/api/v1/'

export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
}

export function isDemoApiRequest(input: RequestInfo | URL, pageUrl = window.location.href): boolean {
  const url = new URL(requestUrl(input), pageUrl)
  const mockApiUrl = new URL(MOCK_API_PATH, pageUrl)

  return url.origin === mockApiUrl.origin && url.pathname.startsWith(mockApiUrl.pathname)
}

// ── Reporter image uploads ─────────────────────────────────────────────────
// Mirrors the server contract closely enough that the demo exercises the same
// error paths: POST …/feedback_submission_sessions/:id/uploads with one file in
// `image`, DELETE …/uploads/:upload_id.

export const DEMO_UPLOADS_MAX = 5
export const DEMO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
const DEMO_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const UPLOAD_PATH = /\/feedback_submission_sessions\/([^/]+)\/uploads(?:\/([^/?]+))?(?:\?.*)?$/

export interface DemoUpload {
  id: string
  sessionId: string
  field: string
  name: string
  content_type: string
  size: number
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * Answers an uploads request against `store`, or returns null when the request
 * is not for the uploads endpoint so the caller can try its other routes.
 */
export function mockUploadResponse(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  store: DemoUpload[],
): Response | null {
  const match = UPLOAD_PATH.exec(requestUrl(input))
  if (!match) return null
  const [, sessionId, uploadId] = match
  const method = (init?.method ?? 'GET').toUpperCase()

  if (method === 'DELETE' && uploadId) {
    const index = store.findIndex(upload => upload.sessionId === sessionId && upload.id === uploadId)
    if (index === -1) return json({ error: { code: 'not_found' } }, 404)
    store.splice(index, 1)
    return new Response(null, { status: 204 })
  }

  if (method !== 'POST' || uploadId) return json({ error: { code: 'not_found' } }, 404)

  const headers = new Headers(init?.headers)
  if (!headers.get('X-MTB-Capture-Policy')) return json({ error: { code: 'capture_policy_required' } }, 422)

  const body = init?.body
  const entries = body instanceof FormData ? [...body.entries()] : []
  const file = body instanceof FormData ? body.get('image') : null
  if (!(file instanceof Blob) || entries.length !== 1) {
    return json({ error: { code: 'unsupported_image_type' } }, 422)
  }
  if (!DEMO_UPLOAD_TYPES.includes(file.type)) return json({ error: { code: 'unsupported_image_type' } }, 422)
  if (file.size > DEMO_UPLOAD_MAX_BYTES) {
    return json({ error: { code: 'upload_too_large', max_bytes: DEMO_UPLOAD_MAX_BYTES } }, 413)
  }
  if (store.filter(upload => upload.sessionId === sessionId).length >= DEMO_UPLOADS_MAX) {
    return json({ error: { code: 'too_many_uploads' } }, 422)
  }

  const upload: DemoUpload = {
    id: `upload_${store.length + 1}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    field: 'image',
    name: file instanceof File ? file.name : 'image',
    content_type: file.type,
    size: file.size,
  }
  store.push(upload)
  return json({ upload: { id: upload.id, content_type: upload.content_type, size: upload.size } }, 201)
}
