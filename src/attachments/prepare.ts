/**
 * Turns whatever a reporter picked, pasted or dropped into something the
 * uploads endpoint accepts: PNG, JPEG, WebP or GIF, at most 10 MB.
 *
 * Phone photos are the reason this exists. They arrive as 4000px+ JPEGs or
 * HEIC, carry EXIF (GPS included), and routinely blow past the size limit —
 * so everything except GIF is decoded and re-encoded through a canvas, which
 * downscales the longest edge to 2560px and drops the metadata on the way.
 * GIFs pass through untouched: a canvas would flatten the animation.
 */

export const MAX_ATTACHMENTS = 5
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENT_EDGE = 2560
export const JPEG_QUALITY = 0.85
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export type PrepareFailure = 'unsupported' | 'too_large'
export type PrepareResult = { ok: true; file: File } | { ok: false; reason: PrepareFailure }

// Phones and some OS pickers hand over files with an empty MIME type; the
// extension is all there is to go on.
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|heic|heif|avif|bmp)$/i

export function isAcceptedImageType(type: string): boolean {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type)
}

export function looksLikeImage(file: Blob & { name?: string }): boolean {
  if (file.type) return file.type.startsWith('image/')
  return IMAGE_EXTENSION.test(file.name ?? '')
}

export async function prepareAttachment(file: File): Promise<PrepareResult> {
  if (!looksLikeImage(file)) return { ok: false, reason: 'unsupported' }

  if (file.type === 'image/gif') return withinLimit(file)

  const bitmap = await decode(file)
  if (!bitmap) {
    // No canvas pipeline here (tests, very old browsers) or the browser cannot
    // read this format (HEIC outside Safari). An accepted type can still go up
    // as-is; anything else would only bounce off the server.
    return isAcceptedImageType(file.type) ? withinLimit(file) : { ok: false, reason: 'unsupported' }
  }

  try {
    const encoded = await reencode(bitmap, file.type === 'image/png' ? 'image/png' : 'image/jpeg')
    if (!encoded) {
      return isAcceptedImageType(file.type) ? withinLimit(file) : { ok: false, reason: 'unsupported' }
    }
    return withinLimit(new File([encoded], renamed(file.name, encoded.type), { type: encoded.type }))
  } finally {
    bitmap.close?.()
  }
}

function withinLimit(file: File): PrepareResult {
  return file.size <= MAX_ATTACHMENT_BYTES ? { ok: true, file } : { ok: false, reason: 'too_large' }
}

interface Decoded {
  width: number
  height: number
  source: CanvasImageSource
  close?: () => void
}

async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
  try {
    const bitmap = await createImageBitmap(file)
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() }
  } catch {
    return null
  }
}

async function reencode(image: Decoded, preferred: 'image/png' | 'image/jpeg'): Promise<Blob | null> {
  const scale = Math.min(1, MAX_ATTACHMENT_EDGE / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const draw = (type: 'image/png' | 'image/jpeg') => {
    ctx.clearRect(0, 0, width, height)
    // JPEG has no alpha: a transparent WebP would otherwise come out black.
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(image.source, 0, 0, width, height)
    return toBlob(canvas, type)
  }

  const first = await draw(preferred)
  // A photo saved as PNG can stay over the limit even at 2560px; JPEG is the
  // only way it fits.
  if (first && preferred === 'image/png' && first.size > MAX_ATTACHMENT_BYTES) {
    return draw('image/jpeg')
  }
  return first
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(blob => resolve(blob), type, type === 'image/jpeg' ? JPEG_QUALITY : undefined)
    } catch {
      resolve(null)
    }
  })
}

function renamed(name: string, type: string): string {
  const ext = type === 'image/png' ? 'png' : 'jpg'
  const base = (name || 'image').replace(/\.[^./\\]+$/, '') || 'image'
  return `${base}.${ext}`
}
