import { afterEach, describe, expect, it, vi } from 'vitest'

import { SubmissionLifecycle, IDLE_CAPTURE_MS, SCREENSHOT_WAIT_MS, AttachmentUploadError } from './submission-lifecycle'
import { UploadRejectedError } from '../api/client'
import { captureBaseScreenshot } from '../screenshot/capture'
import type { ApiClient } from '../api/client'
import type { SubmissionLifecycleDeps, SubmissionLifecycleHost } from './submission-lifecycle'

vi.mock('../screenshot/capture', () => ({
  bakeAnnotatedScreenshot: vi.fn(),
  captureBaseScreenshot: vi.fn(),
  warmFontEmbedCss: vi.fn().mockResolvedValue(undefined),
}))

describe('SubmissionLifecycle screenshot orchestration', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('captures the marked viewport after the reporter pauses, before Session creation', async () => {
    vi.useFakeTimers()
    vi.mocked(captureBaseScreenshot).mockResolvedValue(null)
    const apiClient = {
      createSubmissionSession: vi.fn(),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)

    lifecycle.beginBaseCapture()
    await vi.advanceTimersByTimeAsync(IDLE_CAPTURE_MS - 1)
    expect(captureBaseScreenshot).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(captureBaseScreenshot).toHaveBeenCalledTimes(1)
    expect(apiClient.createSubmissionSession).not.toHaveBeenCalled()
  })

  it('cancels a pending marked-viewport capture when screenshot consent is withdrawn', async () => {
    vi.useFakeTimers()
    const apiClient = {
      createSubmissionSession: vi.fn(),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)

    lifecycle.beginBaseCapture()
    lifecycle.setScreenshotEnabled(false)
    await vi.advanceTimersByTimeAsync(IDLE_CAPTURE_MS)

    expect(captureBaseScreenshot).not.toHaveBeenCalled()
  })

  it('starts the default screenshot after the Session request resolves', async () => {
    let resolveSubmission!: (submission: {
      id: string
      token: string
      ai_clarify_available: boolean
    }) => void
    const submissionRequest = new Promise<{
      id: string
      token: string
      ai_clarify_available: boolean
    }>((resolve) => {
      resolveSubmission = resolve
    })
    vi.mocked(captureBaseScreenshot).mockResolvedValue(null)

    const createSubmissionSession = vi.fn().mockReturnValue(submissionRequest)
    const apiClient = {
      createSubmissionSession,
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)

    const started = lifecycle.start('Export is broken', null, undefined)
    await vi.waitFor(() => expect(createSubmissionSession).toHaveBeenCalledTimes(1))

    expect(captureBaseScreenshot).not.toHaveBeenCalled()

    resolveSubmission({
      id: 'submission_1',
      token: 'secret',
      ai_clarify_available: false,
    })
    await started
    await vi.waitFor(() => expect(captureBaseScreenshot).toHaveBeenCalledTimes(1))
  })

  it('lets a marked-viewport capture wait for Session credentials when proxy fallback is needed', async () => {
    vi.useFakeTimers()
    let resolveSubmission!: (submission: {
      id: string
      token: string
      ai_clarify_available: boolean
    }) => void
    const submissionRequest = new Promise<{
      id: string
      token: string
      ai_clarify_available: boolean
    }>((resolve) => {
      resolveSubmission = resolve
    })
    const resolveScreenshotResourceUrl = vi.fn().mockResolvedValue('https://image-proxy.example.com/signed')
    vi.mocked(captureBaseScreenshot).mockImplementation(async (resolver) => {
      await resolver?.('https://cdn.example.com/photo.png', 'image/png')
      return null
    })
    const apiClient = {
      createSubmissionSession: vi.fn().mockReturnValue(submissionRequest),
      resolveScreenshotResourceUrl,
      uploadScreenshot: vi.fn(),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)

    lifecycle.beginBaseCapture()
    await vi.advanceTimersByTimeAsync(IDLE_CAPTURE_MS)
    expect(captureBaseScreenshot).toHaveBeenCalledTimes(1)
    expect(resolveScreenshotResourceUrl).not.toHaveBeenCalled()

    const started = lifecycle.start('Export is broken', null, undefined)
    await vi.advanceTimersToNextTimerAsync()
    await vi.advanceTimersToNextTimerAsync()
    expect(resolveScreenshotResourceUrl).not.toHaveBeenCalled()

    resolveSubmission({
      id: 'submission_1',
      token: 'secret',
      ai_clarify_available: false,
    })
    await vi.runAllTimersAsync()
    await started
    await vi.waitFor(() => {
      expect(resolveScreenshotResourceUrl).toHaveBeenCalledWith(
        'submission_1',
        'secret',
        'https://cdn.example.com/photo.png',
        'image/png',
        expect.any(AbortSignal),
      )
    })
  })

  it('waits for the Session only when screenshot proxy fallback is needed', async () => {
    let resolveSubmission!: (submission: {
      id: string
      token: string
      ai_clarify_available: boolean
    }) => void
    const submissionRequest = new Promise<{
      id: string
      token: string
      ai_clarify_available: boolean
    }>((resolve) => {
      resolveSubmission = resolve
    })
    const resolveScreenshotResourceUrl = vi.fn().mockResolvedValue('https://image-proxy.example.com/signed')
    vi.mocked(captureBaseScreenshot).mockImplementation(async (resolver) => {
      await resolver?.('https://cdn.example.com/photo.png', 'image/png')
      return null
    })

    const apiClient = {
      createSubmissionSession: vi.fn().mockReturnValue(submissionRequest),
      resolveScreenshotResourceUrl,
      uploadScreenshot: vi.fn(),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)

    const started = lifecycle.start('Export is broken', null, undefined)

    resolveSubmission({
      id: 'submission_1',
      token: 'secret',
      ai_clarify_available: false,
    })
    await started
    await vi.waitFor(() => {
      expect(resolveScreenshotResourceUrl).toHaveBeenCalledWith(
        'submission_1',
        'secret',
        'https://cdn.example.com/photo.png',
        'image/png',
        expect.any(AbortSignal),
      )
    })
  })

  it('aborts the concurrent screenshot when Session creation fails', async () => {
    let captureSignal: AbortSignal | undefined
    vi.mocked(captureBaseScreenshot).mockImplementation((_resolver, signal) => {
      captureSignal = signal
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve(null)))
    })
    const apiClient = {
      createSubmissionSession: vi.fn().mockRejectedValue(new Error('Session unavailable')),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)

    await expect(lifecycle.start('Export is broken', null, undefined)).resolves.toBeNull()
    await new Promise(r => setTimeout(r, 0))

    if (captureSignal) {
      expect(captureSignal.aborted).toBe(true)
    } else {
      expect(captureBaseScreenshot).not.toHaveBeenCalled()
    }
  })

  it('aborts a stalled screenshot and finalizes after five seconds', async () => {
    let captureSignal: AbortSignal | undefined
    vi.mocked(captureBaseScreenshot).mockImplementation((_resolver, signal) => {
      captureSignal = signal
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve(null)))
    })

    const finalizeSubmissionSession = vi.fn().mockResolvedValue({
      id: 'FB-1',
      status: 'received',
      project_id: 'project_1',
    })
    const apiClient = {
      createSubmissionSession: vi.fn().mockResolvedValue({
        id: 'submission_1',
        token: 'secret',
        ai_clarify_available: false,
      }),
      finalizeSubmissionSession,
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)

    await lifecycle.start('Export is broken', null, undefined)
    await new Promise(r => setTimeout(r, 0))
    vi.useFakeTimers()
    const finalized = lifecycle.finalize()

    await vi.advanceTimersByTimeAsync(SCREENSHOT_WAIT_MS - 1)
    expect(finalizeSubmissionSession).not.toHaveBeenCalled()
    expect(captureSignal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(captureSignal?.aborted).toBe(true)
    await vi.runAllTimersAsync()
    await finalized
    expect(finalizeSubmissionSession).toHaveBeenCalledWith('submission_1', 'secret')
  })
})

describe('SubmissionLifecycle reporter images', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
  const session = { id: 'submission_1', token: 'secret', ai_clarify_available: false }
  const feedback = { id: 'FB-1', status: 'received', project_id: 'project_1' }

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('uploads after the Session exists, one at a time, and finalizes only after the last one', async () => {
    const events: string[] = []
    const created = deferred<typeof session>()
    const uploads = [deferred<unknown>(), deferred<unknown>()]
    let uploadCalls = 0
    const uploadImage = vi.fn((_id: string, _token: string, file: File): Promise<unknown> => {
      events.push(`upload:${file.name}`)
      return uploads[uploadCalls++].promise
    })
    const apiClient = {
      createSubmissionSession: vi.fn(() => {
        events.push('create')
        return created.promise
      }),
      finalizeSubmissionSession: vi.fn(async () => {
        events.push('finalize')
        return feedback
      }),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
      uploadImage,
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)
    lifecycle.setScreenshotEnabled(false)

    const started = lifecycle.start('Swap the hero', null, undefined, [png('a.png'), png('b.png')])
    await vi.waitFor(() => expect(events).toEqual(['create']))
    expect(uploadImage).not.toHaveBeenCalled()

    created.resolve(session)
    await started
    await vi.waitFor(() => expect(events).toEqual(['create', 'upload:a.png']))

    const finalized = lifecycle.finalize()
    uploads[0].resolve({ id: 'up_1' })
    await vi.waitFor(() => expect(events).toEqual(['create', 'upload:a.png', 'upload:b.png']))
    // Longer than the screenshot's best-effort wait: images are not dropped on a timer.
    await new Promise(r => setTimeout(r, 20))
    expect(apiClient.finalizeSubmissionSession).not.toHaveBeenCalled()

    uploads[1].resolve({ id: 'up_2' })
    await finalized
    expect(events).toEqual(['create', 'upload:a.png', 'upload:b.png', 'finalize'])
    expect(uploadImage).toHaveBeenCalledWith('submission_1', 'secret', expect.any(File), expect.any(AbortSignal))
  })

  it('does not wait out the screenshot timeout for images', async () => {
    vi.useFakeTimers()
    const upload = deferred<unknown>()
    const apiClient = {
      createSubmissionSession: vi.fn().mockResolvedValue(session),
      finalizeSubmissionSession: vi.fn().mockResolvedValue(feedback),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
      uploadImage: vi.fn(() => upload.promise),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)
    lifecycle.setScreenshotEnabled(false)

    const started = lifecycle.start('Swap the hero', null, undefined, [png('a.png')])
    await vi.runAllTimersAsync()
    await started
    const finalized = lifecycle.finalize()
    await vi.advanceTimersByTimeAsync(SCREENSHOT_WAIT_MS * 3)
    expect(apiClient.finalizeSubmissionSession).not.toHaveBeenCalled()

    upload.resolve({ id: 'up_1' })
    await vi.runAllTimersAsync()
    await finalized
    expect(apiClient.finalizeSubmissionSession).toHaveBeenCalledTimes(1)
  })

  it('caps the upload count at the Session\'s uploads_max', async () => {
    const uploadImage = vi.fn().mockResolvedValue({ id: 'up' })
    const apiClient = {
      createSubmissionSession: vi.fn().mockResolvedValue({ ...session, uploads_max: 2 }),
      finalizeSubmissionSession: vi.fn().mockResolvedValue(feedback),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
      uploadImage,
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)
    lifecycle.setScreenshotEnabled(false)

    await lifecycle.start('x', null, undefined, [png('a.png'), png('b.png'), png('c.png')])
    await lifecycle.finalize()
    expect(uploadImage).toHaveBeenCalledTimes(2)
  })

  it('shows a retryable upload failure instead of finalizing without the images, and retries only what failed', async () => {
    const uploadImage = vi.fn()
      .mockResolvedValueOnce({ id: 'up_1' })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ id: 'up_2' })
    const apiClient = {
      createSubmissionSession: vi.fn().mockResolvedValue(session),
      finalizeSubmissionSession: vi.fn().mockResolvedValue(feedback),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
      uploadImage,
    } as unknown as ApiClient
    const { lifecycle, host } = buildLifecycleWithHost(apiClient, { background: true })
    lifecycle.setScreenshotEnabled(false)

    await lifecycle.start('x', null, undefined, [png('a.png'), png('b.png')])
    await lifecycle.finalize()

    expect(apiClient.finalizeSubmissionSession).not.toHaveBeenCalled()
    expect(host.onFinalizeFailure).toHaveBeenCalledWith(expect.any(Function), 'uploads')

    const retry = host.onFinalizeFailure.mock.calls[0][0] as () => void
    retry()
    await vi.waitFor(() => expect(host.onFinalized).toHaveBeenCalled())
    expect(host.onReenterBackground).toHaveBeenCalled()
    expect(uploadImage).toHaveBeenCalledTimes(3)
    expect((uploadImage.mock.calls[2][2] as File).name).toBe('b.png')
    expect(apiClient.finalizeSubmissionSession).toHaveBeenCalledTimes(1)
  })

  it('lets the feedback through on retry when the server permanently rejected an image', async () => {
    const uploadImage = vi.fn().mockRejectedValue(new UploadRejectedError(422, 'unsupported_image_type'))
    const apiClient = {
      createSubmissionSession: vi.fn().mockResolvedValue(session),
      finalizeSubmissionSession: vi.fn().mockResolvedValue(feedback),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
      uploadImage,
    } as unknown as ApiClient
    const { lifecycle, host } = buildLifecycleWithHost(apiClient, { background: true })
    lifecycle.setScreenshotEnabled(false)

    await lifecycle.start('x', null, undefined, [png('a.png')])
    await lifecycle.finalize()
    expect(host.onFinalizeFailure).toHaveBeenCalledWith(expect.any(Function), 'uploads')

    ;(host.onFinalizeFailure.mock.calls[0][0] as () => void)()
    await vi.waitFor(() => expect(host.onFinalized).toHaveBeenCalled())
    expect(uploadImage).toHaveBeenCalledTimes(1)
  })

  it('throws a typed error from a foreground finalize whose images failed', async () => {
    const apiClient = {
      createSubmissionSession: vi.fn().mockResolvedValue(session),
      finalizeSubmissionSession: vi.fn().mockResolvedValue(feedback),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
      uploadImage: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)
    lifecycle.setScreenshotEnabled(false)

    await lifecycle.start('x', null, undefined, [png('a.png')])
    await expect(lifecycle.finalize()).rejects.toBeInstanceOf(AttachmentUploadError)
    expect(apiClient.finalizeSubmissionSession).not.toHaveBeenCalled()
  })

  it('aborts in-flight uploads when the submission is abandoned', async () => {
    let signal: AbortSignal | undefined
    const apiClient = {
      createSubmissionSession: vi.fn().mockResolvedValue(session),
      abandonSubmissionSession: vi.fn().mockResolvedValue(undefined),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
      uploadImage: vi.fn((_id: string, _token: string, _file: File, s: AbortSignal) => {
        signal = s
        return new Promise(() => {})
      }),
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)
    lifecycle.setScreenshotEnabled(false)

    await lifecycle.start('x', null, undefined, [png('a.png')])
    await vi.waitFor(() => expect(signal).toBeDefined())
    lifecycle.abandon()
    expect(signal?.aborted).toBe(true)
  })

  it('creates no upload work when nothing was attached', async () => {
    const uploadImage = vi.fn()
    const apiClient = {
      createSubmissionSession: vi.fn().mockResolvedValue(session),
      finalizeSubmissionSession: vi.fn().mockResolvedValue(feedback),
      resolveScreenshotResourceUrl: vi.fn(),
      uploadScreenshot: vi.fn(),
      uploadImage,
    } as unknown as ApiClient
    const lifecycle = buildLifecycle(apiClient)
    lifecycle.setScreenshotEnabled(false)

    await lifecycle.start('x', null, undefined)
    await lifecycle.finalize()
    expect(uploadImage).not.toHaveBeenCalled()
    expect(apiClient.finalizeSubmissionSession).toHaveBeenCalledTimes(1)
  })
})

function buildLifecycleWithHost(apiClient: ApiClient, options: { background: boolean }) {
  const deps = {
    apiClient,
    consoleCollector: { getErrors: () => [] },
    breadcrumbCollector: { getBreadcrumbs: () => [] },
    brandColors: undefined,
    shadow: () => document.body.attachShadow({ mode: 'open' }),
    messages: () => ({}),
    user: () => undefined,
  } as unknown as SubmissionLifecycleDeps
  const host = {
    isBackground: () => options.background,
    onFinalizeFailure: vi.fn(),
    onReenterBackground: vi.fn(),
    onFinalized: vi.fn(),
  } satisfies SubmissionLifecycleHost
  return { lifecycle: new SubmissionLifecycle(deps, host), host }
}

function buildLifecycle(apiClient: ApiClient): SubmissionLifecycle {
  const deps = {
    apiClient,
    consoleCollector: { getErrors: () => [] },
    breadcrumbCollector: { getBreadcrumbs: () => [] },
    brandColors: undefined,
    shadow: () => document.body.attachShadow({ mode: 'open' }),
    messages: () => ({}),
    user: () => undefined,
  } as unknown as SubmissionLifecycleDeps
  const host = {
    isBackground: () => false,
    onFinalizeFailure: vi.fn(),
    onReenterBackground: vi.fn(),
    onFinalized: vi.fn(),
  } satisfies SubmissionLifecycleHost

  return new SubmissionLifecycle(deps, host)
}
