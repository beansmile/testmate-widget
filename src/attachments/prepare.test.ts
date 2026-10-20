import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_EDGE, prepareAttachment } from './prepare'

function fileOf(size: number, name: string, type: string): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('prepareAttachment without a canvas pipeline', () => {
  it('rejects files that are not images', async () => {
    await expect(prepareAttachment(fileOf(10, 'notes.pdf', 'application/pdf'))).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })

  it('passes accepted types through unchanged', async () => {
    const file = fileOf(10, 'hero.png', 'image/png')
    const result = await prepareAttachment(file)
    expect(result).toEqual({ ok: true, file })
  })

  it('passes GIFs through untouched and enforces the size ceiling on them', async () => {
    const gif = fileOf(10, 'spinner.gif', 'image/gif')
    await expect(prepareAttachment(gif)).resolves.toEqual({ ok: true, file: gif })
    await expect(prepareAttachment(fileOf(MAX_ATTACHMENT_BYTES + 1, 'big.gif', 'image/gif'))).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    })
  })

  it('reports an oversize accepted image it cannot shrink as too_large', async () => {
    await expect(prepareAttachment(fileOf(MAX_ATTACHMENT_BYTES + 1, 'big.jpg', 'image/jpeg'))).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    })
  })

  it('treats an undecodable HEIC as unsupported rather than uploading it', async () => {
    await expect(prepareAttachment(fileOf(10, 'IMG_0001.HEIC', ''))).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })
})

describe('prepareAttachment with a canvas pipeline', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubCanvas(bitmap: { width: number; height: number }, outputSize = 100) {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ ...bitmap, close }))
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      drawImage,
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D)
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback,
      type?: string,
    ) {
      cb(new Blob([new Uint8Array(outputSize)], { type }))
    })
    return { close, drawImage, toBlob }
  }

  it('downscales the longest edge and re-encodes a phone photo as JPEG', async () => {
    const { close, drawImage, toBlob } = stubCanvas({ width: 4032, height: 3024 })
    const result = await prepareAttachment(fileOf(5_000_000, 'IMG_0001.HEIC', 'image/heic'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.type).toBe('image/jpeg')
    expect(result.file.name).toBe('IMG_0001.jpg')
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, MAX_ATTACHMENT_EDGE, 1920)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85)
    expect(close).toHaveBeenCalled()
  })

  it('keeps a PNG a PNG and leaves small images at their size', async () => {
    const { drawImage, toBlob } = stubCanvas({ width: 800, height: 600 })
    const result = await prepareAttachment(fileOf(1000, 'mock.png', 'image/png'))

    expect(result.ok && result.file.type).toBe('image/png')
    expect(result.ok && result.file.name).toBe('mock.png')
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined)
  })

  it('falls back to JPEG when the PNG re-encode is still over the limit', async () => {
    const { toBlob } = stubCanvas({ width: 2000, height: 2000 })
    toBlob.mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
      cb(new Blob([new Uint8Array(type === 'image/png' ? MAX_ATTACHMENT_BYTES + 1 : 500)], { type }))
    })
    const result = await prepareAttachment(fileOf(9_000_000, 'photo.png', 'image/png'))
    expect(result.ok && result.file.type).toBe('image/jpeg')
    expect(result.ok && result.file.name).toBe('photo.jpg')
  })

  it('does not decode GIFs', async () => {
    stubCanvas({ width: 10, height: 10 })
    const gif = fileOf(10, 'anim.gif', 'image/gif')
    await expect(prepareAttachment(gif)).resolves.toEqual({ ok: true, file: gif })
    expect(createImageBitmap).not.toHaveBeenCalled()
  })
})
