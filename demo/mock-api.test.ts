import { describe, expect, it } from 'vitest'
import { DEMO_UPLOAD_MAX_BYTES, isDemoApiRequest, mockUploadResponse } from './mock-api'
import type { DemoUpload } from './mock-api'

describe('isDemoApiRequest', () => {
  const pageUrl = 'http://localhost:5173/'

  it('matches requests to the demo mock API', () => {
    expect(isDemoApiRequest('/__mtb_mock/api/v1/feedback', pageUrl)).toBe(true)
    expect(isDemoApiRequest(new URL('/__mtb_mock/api/v1/feedback_submission_sessions', pageUrl), pageUrl)).toBe(true)
  })

  it('does not match a custom API URL with the same endpoint path', () => {
    expect(isDemoApiRequest('https://api.example.com/api/v1/feedback', pageUrl)).toBe(false)
  })

  it('does not match a similar path outside the mock API boundary', () => {
    expect(isDemoApiRequest('/__mtb_mock/api/v10/feedback', pageUrl)).toBe(false)
  })
})

describe('mockUploadResponse', () => {
  const url = 'http://localhost:5173/__mtb_mock/api/v1/widget/feedback_submission_sessions/s1/uploads'
  const headers = { 'X-Project-Key': 'k', 'X-Submission-Token': 't', 'X-MTB-Capture-Policy': 'sensitive-data-v1' }

  function post(file: Blob, name = 'a.png', extraHeaders: Record<string, string> = headers) {
    const body = new FormData()
    body.append('image', file, name)
    return { method: 'POST', headers: extraHeaders, body }
  }

  it('ignores requests for other endpoints', () => {
    expect(mockUploadResponse('http://localhost/__mtb_mock/api/v1/widget/feedback_submission_sessions', { method: 'POST' }, [])).toBeNull()
  })

  it('stores an image from the image field and answers 201', async () => {
    const store: DemoUpload[] = []
    const res = mockUploadResponse(url, post(new Blob(['x'], { type: 'image/png' }), 'hero.png'), store)!
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.upload).toMatchObject({ content_type: 'image/png', size: 1 })
    expect(store).toEqual([expect.objectContaining({ sessionId: 's1', field: 'image', name: 'hero.png' })])
  })

  it('enforces the contract errors', async () => {
    const store: DemoUpload[] = []
    expect(mockUploadResponse(url, post(new Blob(['x'], { type: 'image/png' }), 'a.png', { 'X-Submission-Token': 't' }), store)!.status).toBe(422)
    expect(mockUploadResponse(url, post(new Blob(['x'], { type: 'application/pdf' })), store)!.status).toBe(422)
    const big = mockUploadResponse(url, post(new Blob([new Uint8Array(DEMO_UPLOAD_MAX_BYTES + 1)], { type: 'image/png' })), store)!
    expect(big.status).toBe(413)
    expect((await big.json()).error).toEqual({ code: 'upload_too_large', max_bytes: DEMO_UPLOAD_MAX_BYTES })
    for (let i = 0; i < 5; i++) mockUploadResponse(url, post(new Blob(['x'], { type: 'image/png' })), store)
    const sixth = mockUploadResponse(url, post(new Blob(['x'], { type: 'image/png' })), store)!
    expect(sixth.status).toBe(422)
    expect((await sixth.json()).error.code).toBe('too_many_uploads')
  })

  it('deletes an upload', () => {
    const store: DemoUpload[] = []
    mockUploadResponse(url, post(new Blob(['x'], { type: 'image/png' })), store)
    const res = mockUploadResponse(`${url}/${store[0].id}`, { method: 'DELETE', headers }, store)!
    expect(res.status).toBe(204)
    expect(store).toHaveLength(0)
  })
})
