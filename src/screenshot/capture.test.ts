import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toJpeg } from 'html-to-image'
import { bakeAnnotatedScreenshot, captureScreenshot, captureBaseScreenshot, screenshotAnnotationOffsets } from './capture'
import { parsePathPolylines } from './svg-path'
import { getFontEmbedCSS } from 'html-to-image'

vi.mock('html-to-image', () => ({
  toJpeg: vi.fn(async () => 'data:image/jpeg;base64,/9j/AA=='),
  getFontEmbedCSS: vi.fn(async () => ''),
}))

const toJpegMock = vi.mocked(toJpeg)
const JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/AA=='
const MASK_GRAY = /^(#e5e7eb|rgb\(229, 231, 235\))$/i

// What html-to-image hands the capture back through its (patched) onClone
// hook: the clone tree built the way clone-node.js builds it — filter first,
// shallow clone, children, the input value copied in, then the hook with the
// finished clone. The privacy tests read the masks off this tree.
interface CloneOptions {
  filter?: (node: HTMLElement) => boolean
  onClone?: (nativeNode: Node, clonedNode: Node) => Node | void
}

function cloneLikeHtmlToImage(node: Node, options: CloneOptions): Node {
  const walk = (native: Node, isRoot: boolean): Node | null => {
    if (!isRoot && options.filter && !options.filter(native as HTMLElement)) return null
    const clone = native.cloneNode(false)
    for (const child of Array.from(native.childNodes)) {
      const cloned = walk(child, false)
      if (cloned) clone.appendChild(cloned)
    }
    if (native instanceof HTMLInputElement) (clone as HTMLInputElement).setAttribute('value', native.value)
    if (native instanceof HTMLTextAreaElement) (clone as HTMLTextAreaElement).innerHTML = native.value
    return options.onClone ? options.onClone(native, clone) ?? clone : clone
  }
  return walk(node, true)!
}

let lastClone: Node | null = null

function clonedElement<T extends Element = HTMLElement>(selector: string): T {
  const element = (lastClone as Element | null)?.querySelector<T>(selector)
  if (!element) throw new Error(`No ${selector} in the screenshot clone`)
  return element
}

function clonedTextNodes(): string[] {
  const walker = document.createTreeWalker(lastClone!, NodeFilter.SHOW_TEXT)
  const texts: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.hasAttribute('data-mtb-mask')) texts.push(node.textContent ?? '')
  }
  return texts
}

class ImmediatelyFailingImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.())
  }
}

describe('captureScreenshot', () => {
  beforeEach(() => {
    lastClone = null
    toJpegMock.mockImplementation(async (node, options) => {
      lastClone = cloneLikeHtmlToImage(node, options as CloneOptions)
      return JPEG_DATA_URL
    })
    vi.stubGlobal('Image', ImmediatelyLoadingImage)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => mockCanvasContext() as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['jpeg'], { type: 'image/jpeg' }))
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    toJpegMock.mockClear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('computes the font embed CSS once and reuses it across captures', async () => {
    const fontMock = vi.mocked(getFontEmbedCSS)
    const callsBefore = fontMock.mock.calls.length

    await captureScreenshot()
    await captureScreenshot()

    // The font set does not change while the page lives; re-walking every
    // stylesheet and re-fetching every font file per capture is what made a
    // single submission fire a hundred-odd font requests.
    expect(fontMock.mock.calls.length - callsBefore).toBeLessThanOrEqual(1)
    const lastOptions = toJpegMock.mock.calls[toJpegMock.mock.calls.length - 1]?.[1]
    expect(lastOptions?.fontEmbedCSS).toBe('')
  })

  it('captures a compressed jpeg blob', async () => {
    const blob = await captureScreenshot()

    expect(blob).toBeInstanceOf(Blob)
    expect(blob?.type).toBe('image/jpeg')
    expect(toJpegMock).toHaveBeenCalledWith(
      document.documentElement,
      expect.objectContaining({
        quality: 0.85,
        pixelRatio: 1,
        skipFonts: false,
        skipAutoScale: false,
      }),
    )
  })

  it('keeps the screenshot when a cross-origin image needs a safe placeholder', async () => {
    toJpegMock.mockImplementationOnce(async (_node, options) => {
      if (!options?.imagePlaceholder) throw new Error('cross-origin image failed')

      return 'data:image/jpeg;base64,/9j/AA=='
    })

    const blob = await captureScreenshot()

    expect(blob).toBeInstanceOf(Blob)
    expect(toJpegMock).toHaveBeenCalledWith(
      document.documentElement,
      expect.objectContaining({
        imagePlaceholder: expect.stringMatching(/^data:image\/gif;base64,/),
      }),
    )
  })

  // Rasterizing a page taller than the viewport used to be the widget's single
  // heaviest block of main-thread work — and the bake cropped the result back
  // to roughly a viewport anyway. Height of the document must not leak into
  // the capture size.
  describe('on a page much taller than the viewport', () => {
    function sizeBody(width: number, height: number): void {
      Object.defineProperty(document.body, 'clientWidth', { value: width, configurable: true })
      Object.defineProperty(document.body, 'clientHeight', { value: height, configurable: true })
    }

    it('captures the viewport at full resolution', async () => {
      sizeBody(1600, 20_000)

      await captureScreenshot()

      expect(toJpegMock.mock.calls[0][1]).toMatchObject({
        pixelRatio: 1,
        width: window.innerWidth,
        height: window.innerHeight,
      })
    })

    it('culls only elements below the viewport from the clone', async () => {
      sizeBody(1600, 20_000)
      const below = document.createElement('section')
      vi.spyOn(below, 'getBoundingClientRect').mockReturnValue(rect(0, 5000, 800, 600))
      const above = document.createElement('section')
      vi.spyOn(above, 'getBoundingClientRect').mockReturnValue(rect(0, -4000, 800, 600))
      const visible = document.createElement('section')
      vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue(rect(0, 100, 800, 300))
      const sizeless = document.createElement('style')
      document.body.append(below, above, visible, sizeless)

      await captureScreenshot()

      const { filter } = toJpegMock.mock.calls[0][1] as { filter: (node: Node) => boolean }
      expect(filter(below)).toBe(false)
      expect(filter(visible)).toBe(true)
      // Culling in-flow content ABOVE the viewport would collapse the clone's
      // layout upward and break the capture's scroll alignment.
      expect(filter(above)).toBe(true)
      // Zero-sized nodes carry styles, not pixels — they must survive the cull.
      expect(filter(sizeless)).toBe(true)
    })

    // FB-17: html-to-image inlines each element's computed height, so a table
    // that lost its below-the-fold rows kept its full height and stretched the
    // rows that remained. Every vertical-align: middle cell then drew its
    // content lower than on screen (82px in the browser reproduction of a
    // 30-row table, ~48px in the reported screenshot) while the baked mark
    // stayed at the reporter's coordinates, a line above its target.
    it('keeps table rows below the viewport so the rows above are not stretched', async () => {
      sizeBody(1280, 6000)
      document.body.innerHTML = '<table><tbody id="tbody"><tr id="row"><td id="cell"><span id="chip">chip</span></td></tr></tbody></table>'
      const row = document.querySelector('#row')!
      const cell = document.querySelector('#cell')!
      const chip = document.querySelector('#chip')!
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(0, 3000, 800, 100))
      vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(rect(0, 3000, 800, 100))
      vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue(rect(10, 3040, 40, 16))

      await captureScreenshot()

      const { filter } = toJpegMock.mock.calls[0][1] as { filter: (node: Node) => boolean }
      // The row's parent is a row group: culling it re-lays-out the table.
      expect(filter(row)).toBe(true)
      // A row keeps its cells for the same reason.
      expect(filter(cell)).toBe(true)
      // Content of a cell that starts below the cut-off can go: whatever the
      // cell re-lays-out is below the cut-off too.
      expect(filter(chip)).toBe(false)
    })

    it('keeps the below-the-fold children of a flex box that reaches into the capture', async () => {
      sizeBody(1280, 6000)
      document.body.innerHTML = '<div id="flex" style="display: flex; flex-direction: column"><div id="grow"></div><div id="tail"></div></div>'
        + '<div id="grid" style="display: grid"><div id="cell"></div></div>'
      const flex = document.querySelector('#flex')!
      const tail = document.querySelector('#tail')!
      const grid = document.querySelector('#grid')!
      const gridCell = document.querySelector('#cell')!
      vi.spyOn(flex, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 800, 3000))
      vi.spyOn(tail, 'getBoundingClientRect').mockReturnValue(rect(0, 2000, 800, 1000))
      vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(rect(0, 3000, 800, 1000))
      vi.spyOn(gridCell, 'getBoundingClientRect').mockReturnValue(rect(0, 3200, 800, 100))

      await captureScreenshot()

      const { filter } = toJpegMock.mock.calls[0][1] as { filter: (node: Node) => boolean }
      // A flex-grow or justify-content sibling above would take its space
      // (250px of drift in the browser reproduction).
      expect(filter(tail)).toBe(true)
      // This grid starts below the cut-off itself, so its re-layout is invisible.
      expect(filter(gridCell)).toBe(false)
    })
  })

  describe('screenshotAnnotationOffsets', () => {
    const base = { dataUrl: 'data:image/jpeg;base64,/9j/AA==', metrics: rect(0, 0, 1280, 720), pageScroll: { x: 0, y: 200 } }

    it('is the anchor brought back to the frame the capture was measured in', () => {
      expect(screenshotAnnotationOffsets(base, [
        { type: 'pin', x: 1, y: 2, captureOffsetX: 0, captureOffsetY: 248 },
        { type: 'draw', x: 1, y: 2, drawPath: 'M 0 0 L 1 1', captureOffsetX: 3, captureOffsetY: 200 },
      ])).toEqual([{ x: 0, y: 48 }, { x: 3, y: 0 }])
    })

    it('is exactly what the bake moves the mark by', async () => {
      vi.stubGlobal('Image', ViewportImage)
      const context = mockCanvasContext()
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => context as unknown as CanvasRenderingContext2D,
      )
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720)
      const annotation = { type: 'pin' as const, x: 600, y: 300, captureOffsetX: 0, captureOffsetY: 248 }

      await bakeAnnotatedScreenshot(base, [annotation])

      const [offset] = screenshotAnnotationOffsets(base, [annotation])
      expect(context.arc).toHaveBeenCalledWith(600 + offset.x, 300 + offset.y, 11, 0, Math.PI * 2)
    })
  })

  it('shifts the clone so the scrolled-to region lands at the canvas origin', async () => {
    vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(rect(0, -2000, 900, 2800))

    await captureScreenshot()

    expect(toJpegMock).toHaveBeenCalledWith(
      document.documentElement,
      expect.objectContaining({
        width: window.innerWidth,
        height: window.innerHeight,
        style: expect.objectContaining({ transform: 'translate(0px, -2000px)' }),
      }),
    )
  })

  // html-to-image inlines every computed style into its clone, margins
  // included. Capturing the body and then translating it by its own viewport
  // rect applied the body's margin twice: on a 1280px viewport a centered
  // 720px body (264px auto margins) rendered at x=544 instead of x=280, and
  // pins baked at viewport coordinates missed their targets by the same amount.
  describe('on a host page whose body is offset by its margins', () => {
    function layOut(root: DOMRect, body: DOMRect): void {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720)
      vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(root)
      vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue(body)
    }

    function captureOptions() {
      return toJpegMock.mock.calls[0][1] as {
        style?: Record<string, string>
        filter: (node: Node) => boolean
        backgroundColor?: string
      }
    }

    it.each([
      ['a centered max-width body', rect(0, 0, 1280, 720), rect(264, 40, 752, 400)],
      ['a plain full-width body', rect(0, 0, 1280, 720), rect(8, 8, 1264, 400)],
      ['a body pushed right by margin-left', rect(0, 0, 1280, 720), rect(200, 0, 1080, 400)],
    ])('captures the document element unshifted for %s', async (_name, root, body) => {
      layOut(root, body)

      await captureScreenshot()

      // The clone root is the document element, which sits at the viewport
      // origin; the body keeps its own cloned margins inside it, so the body's
      // offset must never reach the transform.
      expect(toJpegMock.mock.calls[0][0]).toBe(document.documentElement)
      expect(captureOptions().style).toMatchObject({
        transform: 'translate(0px, 0px)',
        transformOrigin: 'top left',
        margin: '0',
        display: 'flow-root',
        overflow: 'visible',
      })
    })

    it('translates by the root rect only, so a scrolled page still maps 1:1', async () => {
      layOut(rect(0, -600, 1280, 3000), rect(264, -560, 752, 2900))
      vi.stubGlobal('Image', ViewportImage)
      const context = mockCanvasContext()
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
        context as unknown as CanvasRenderingContext2D,
      )

      // A pin on an element at viewport (380, 180) — inside the centered body.
      await captureScreenshot([{ type: 'pin', x: 380, y: 180 }])

      expect(captureOptions().style?.['transform']).toBe('translate(0px, -600px)')
      // The bitmap is the viewport, so the baked pin stays at the viewport
      // coordinates the element occupies — not shifted by the body margin.
      expect(context.arc).toHaveBeenCalledWith(380, 180, 11, 0, Math.PI * 2)
    })

    it('leaves the head out of the clone', async () => {
      layOut(rect(0, 0, 1280, 720), rect(264, 40, 752, 400))

      await captureScreenshot()

      expect(captureOptions().filter(document.head)).toBe(false)
      expect(captureOptions().filter(document.body)).toBe(true)
    })

    describe('background', () => {
      afterEach(() => {
        document.documentElement.style.backgroundColor = ''
        document.body.style.backgroundColor = ''
      })

      it('paints the root background behind the page', async () => {
        document.documentElement.style.backgroundColor = 'rgb(17, 24, 39)'
        document.body.style.backgroundColor = 'rgb(255, 0, 0)'

        await captureScreenshot()

        expect(captureOptions().backgroundColor).toBe('rgb(17, 24, 39)')
      })

      it('falls back to the body background the browser propagates to the canvas', async () => {
        document.body.style.backgroundColor = 'rgb(17, 24, 39)'

        await captureScreenshot()

        expect(captureOptions().backgroundColor).toBe('rgb(17, 24, 39)')
      })

      it('uses white when neither paints a background', async () => {
        document.body.style.backgroundColor = 'rgba(0, 0, 0, 0)'

        await captureScreenshot()

        expect(captureOptions().backgroundColor).toBe('#ffffff')
      })
    })
  })

  it('does not mount anything into the live page while capturing', async () => {
    let bodyChildrenDuringCapture = -1
    document.body.innerHTML = '<main>content</main>'
    toJpegMock.mockImplementationOnce(async () => {
      bodyChildrenDuringCapture = document.body.childElementCount
      return 'data:image/jpeg;base64,/9j/AA=='
    })
    vi.stubGlobal('Image', ImmediatelyFailingImage)

    await captureScreenshot([{ type: 'draw', x: 1, y: 2, drawPath: 'M 0 0 L 5 5' }])

    expect(bodyChildrenDuringCapture).toBe(1)
    expect(document.body.childElementCount).toBe(1)
  })

  it('bakes brand-colored annotations with a fixed neutral outline and no numbers', async () => {
    const context = mockCanvasContext()
    const strokeStyles = trackStyleAssignments(context, 'strokeStyle')
    const fillStyles = trackStyleAssignments(context, 'fillStyle')
    const shadowColors = trackStyleAssignments(context, 'shadowColor')
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )

    await captureScreenshot(
      [
        { type: 'draw', x: 1, y: 2, drawPath: 'M 0 0 L 5 5' },
        { type: 'pin', x: 10, y: 20 },
      ],
      {
        primary: '#2563eb',
        hover: '#1d4ed8',
        active: '#1e40af',
        onPrimary: '#fefefe',
      },
    )

    expect(strokeStyles).toEqual(expect.arrayContaining([
      'rgba(15, 23, 42, 0.72)',
      '#ffffff',
      '#2563eb',
    ]))
    expect(fillStyles).toContain('#2563eb')
    expect(context.fillText).not.toHaveBeenCalled()
    expect(shadowColors).toContain('rgba(15, 23, 42, 0.68)')
  })

  it('returns null instead of the unfiltered screenshot when the bitmap cannot be loaded', async () => {
    vi.stubGlobal('Image', ImmediatelyFailingImage)

    const blob = await captureScreenshot([{ type: 'pin', x: 10, y: 20 }])

    expect(blob).toBeNull()
  })

  it('returns null when the capture itself fails', async () => {
    toJpegMock.mockRejectedValueOnce(new Error('capture failed'))

    const blob = await captureScreenshot()

    expect(blob).toBeNull()
  })

  // Privacy masks are part of html-to-image's clone, never painted onto the
  // bitmap: a cover painted at a live rect lands beside the secret whenever
  // the clone lays out differently from the page (FB-16: a centered column
  // rendered flush-left, the gray box 480px to the right of readable text).
  describe('privacy masks', () => {
    function sizeViewport(): ReturnType<typeof mockCanvasContext> {
      const context = mockCanvasContext()
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
        context as unknown as CanvasRenderingContext2D,
      )
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(3000)
      vi.spyOn(document.body, 'clientWidth', 'get').mockReturnValue(1280)
      vi.spyOn(document.body, 'clientHeight', 'get').mockReturnValue(3000)
      vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1280, 3000))
      return context
    }

    it('masks an rr-block element inside the clone and paints nothing onto the bitmap', async () => {
      const context = sizeViewport()
      const blocked = document.createElement('section')
      blocked.className = 'rr-block'
      blocked.innerHTML = '<p>Account 4242</p><img src="https://cdn.example.com/private.png">'
      vi.spyOn(blocked, 'getBoundingClientRect').mockReturnValue(rect(25, 40, 320, 180))
      document.body.appendChild(blocked)

      const blob = await captureScreenshot()

      expect(blob).toBeInstanceOf(Blob)
      const clone = clonedElement('section.rr-block')
      expect(clone.getAttribute('data-mtb-mask')).toBe('block')
      expect(clone.style.getPropertyValue('background-color')).toMatch(MASK_GRAY)
      expect(clone.style.getPropertyPriority('background-color')).toBe('important')
      expect(clone.style.getPropertyValue('color')).toBe('transparent')
      // Every descendant is hidden on its own: html-to-image inlines
      // `visibility: visible` on each of them, so hiding the block alone would
      // not do.
      expect(clone.querySelector('p')!.style.getPropertyValue('visibility')).toBe('hidden')
      expect(clone.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/gif;base64,/)
      expect(context.fillRect).not.toHaveBeenCalled()
      // The live page is never touched.
      expect(blocked.hasAttribute('data-mtb-mask')).toBe(false)
      expect(blocked.querySelector('img')!.getAttribute('src')).toBe('https://cdn.example.com/private.png')
    })

    it('masks text and form controls inside rr-mask while leaving the region itself alone', async () => {
      sizeViewport()
      const masked = document.createElement('section')
      masked.className = 'rr-mask'
      masked.appendChild(document.createTextNode('Visible account secret'))
      const input = document.createElement('input')
      input.value = 'ordinary form value'
      masked.appendChild(input)
      document.body.appendChild(masked)

      await captureScreenshot()

      expect(clonedElement('section.rr-mask').hasAttribute('data-mtb-mask')).toBe(false)
      const span = clonedElement('section.rr-mask > span[data-mtb-mask="text"]')
      expect(span.textContent).toBe('Visible account secret')
      expect(span.style.getPropertyValue('color')).toBe('transparent')
      expect(span.style.getPropertyValue('background-color')).toMatch(MASK_GRAY)
      const field = clonedElement<HTMLInputElement>('section.rr-mask > input')
      expect(field.getAttribute('data-mtb-mask')).toBe('field')
      expect(field.hasAttribute('value')).toBe(false)
      expect(field.value).toBe('')
      expect(field.style.getPropertyValue('background-color')).toMatch(MASK_GRAY)
      // Live DOM untouched: the text node is still a bare child, the value kept.
      expect(masked.firstChild?.nodeType).toBe(Node.TEXT_NODE)
      expect(input.value).toBe('ordinary form value')
    })

    it('masks built-in sensitive fields and high-confidence secrets, not ordinary content', async () => {
      sizeViewport()
      const password = document.createElement('input')
      password.type = 'password'
      password.value = 'hunter2'
      const card = document.createElement('input')
      card.name = 'notes'
      card.value = '4242 4242 4242 4242'
      const ordinary = document.createElement('input')
      ordinary.name = 'notes'
      ordinary.value = 'export is slow'
      const secretText = document.createTextNode('Key sk-proj-abcdefghijklmnopqrstuvwxyz123456')
      const ordinaryText = document.createTextNode('Order 1234 is delayed')
      document.body.append(password, card, ordinary, secretText, ordinaryText)

      await captureScreenshot()

      expect(clonedElement('input[type="password"]').getAttribute('data-mtb-mask')).toBe('field')
      const [clonedCard, clonedOrdinary] = Array.from((lastClone as Element).querySelectorAll('input[name="notes"]'))
      expect(clonedCard.getAttribute('data-mtb-mask')).toBe('field')
      expect(clonedCard.hasAttribute('value')).toBe(false)
      expect(clonedOrdinary.hasAttribute('data-mtb-mask')).toBe(false)
      expect(clonedOrdinary.getAttribute('value')).toBe('export is slow')
      expect(clonedElement('span[data-mtb-mask="text"]').textContent).toBe('Key sk-proj-abcdefghijklmnopqrstuvwxyz123456')
      expect(clonedTextNodes()).toContain('Order 1234 is delayed')
    })

    // FB-16: settings help text quoting an example URL was masked as a secret
    // because the URL pattern ran into the Chinese sentence after it.
    it('leaves help text that quotes an example URL readable, but masks a URL carrying a token', async () => {
      sizeViewport()
      const help = document.createElement('p')
      help.textContent = 'example.com 或 https://example.com/…；小组件只会在此域名上运行'
      const reset = document.createElement('p')
      reset.textContent = 'Reset at https://app.example.com/reset?token=abc123 before Friday'
      document.body.append(help, reset)

      await captureScreenshot()

      expect(clonedTextNodes()).toContain('example.com 或 https://example.com/…；小组件只会在此域名上运行')
      expect(clonedElement('span[data-mtb-mask="text"]').textContent).toBe('Reset at https://app.example.com/reset?token=abc123 before Friday')
    })

    it('leaves text inside style and script elements alone', async () => {
      sizeViewport()
      const style = document.createElement('style')
      style.textContent = '.hero { background: url(https://cdn.example.com/a.png?v=2) }'
      document.body.appendChild(style)

      await captureScreenshot()

      expect(clonedElement('style').childNodes).toHaveLength(1)
      expect(clonedElement('style').textContent).toBe('.hero { background: url(https://cdn.example.com/a.png?v=2) }')
    })

    it('masks inside the clone wherever the page is scrolled, with nothing painted at viewport coordinates', async () => {
      const context = sizeViewport()
      vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(rect(0, -1200, 1280, 3000))
      const blocked = document.createElement('section')
      blocked.className = 'rr-block'
      vi.spyOn(blocked, 'getBoundingClientRect').mockReturnValue(rect(25, 40, 320, 180))
      const password = document.createElement('input')
      password.type = 'password'
      password.value = 'hunter2'
      vi.spyOn(password, 'getBoundingClientRect').mockReturnValue(rect(10, 300, 180, 32))
      document.body.append(blocked, password)

      await captureScreenshot()

      const options = toJpegMock.mock.calls[0][1] as { style?: Record<string, string> }
      expect(options.style?.['transform']).toBe('translate(0px, -1200px)')
      expect(clonedElement('section.rr-block').getAttribute('data-mtb-mask')).toBe('block')
      expect(clonedElement('input[type="password"]').getAttribute('data-mtb-mask')).toBe('field')
      expect(context.fillRect).not.toHaveBeenCalled()
    })

    // The hook is a local patch of html-to-image. A build without it renders
    // every secret in the clear, and that bitmap must never leave the page.
    it('returns null when the clone hook never ran and there was something to mask', async () => {
      sizeViewport()
      toJpegMock.mockImplementationOnce(async () => JPEG_DATA_URL)
      const blocked = document.createElement('section')
      blocked.className = 'rr-block'
      document.body.appendChild(blocked)

      await expect(captureScreenshot()).resolves.toBeNull()
    })

    it('still captures without the hook when the page has nothing to mask', async () => {
      sizeViewport()
      toJpegMock.mockImplementationOnce(async () => JPEG_DATA_URL)
      document.body.appendChild(document.createTextNode('Order 1234 is delayed'))

      await expect(captureScreenshot()).resolves.toBeInstanceOf(Blob)
    })
  })

  // No captureOffset on the annotation — the shape every client sent before
  // 1.22, and what replayed data still looks like. The capture-time path has to
  // keep working for it, so this and the two unanchored cases in the nested
  // scroller below are the backward-compatibility guard.
  it('maps unanchored annotations 1:1 onto the scrolled viewport capture', async () => {
    const sourceContext = mockCanvasContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => sourceContext as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['jpeg'], { type: 'image/jpeg' }))
    })
    vi.spyOn(document.body, 'clientWidth', 'get').mockReturnValue(1280)
    vi.spyOn(document.body, 'clientHeight', 'get').mockReturnValue(3000)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720)
    vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: -1200,
      top: -1200,
      right: 1280,
      bottom: 1800,
      left: 0,
      width: 1280,
      height: 3000,
      toJSON: () => ({}),
    })
    vi.stubGlobal('Image', ViewportImage)
    const blocked = document.createElement('section')
    blocked.className = 'rr-block'
    vi.spyOn(blocked, 'getBoundingClientRect').mockReturnValue(rect(100, 200, 300, 120))
    document.body.appendChild(blocked)

    await captureScreenshot([{ type: 'pin', x: 640, y: 360 }])

    // The capture is the viewport itself, so viewport coordinates need no
    // scroll translation — the clone was shifted instead.
    const options = toJpegMock.mock.calls[0][1] as { style?: Record<string, string> }
    expect(options.style?.['transform']).toBe('translate(0px, -1200px)')
    expect(clonedElement('section.rr-block').getAttribute('data-mtb-mask')).toBe('block')
    expect(sourceContext.fillRect).not.toHaveBeenCalled()
    expect(sourceContext.arc).toHaveBeenCalledWith(640, 360, 11, 0, Math.PI * 2)
  })

  // An annotation is fixed the moment it is made. Whatever the reporter scrolls
  // past on the way to the submit button — the page itself or a container
  // inside it — the mark must stay on the content it was made over.
  describe('when the page scrolls between annotating and capturing', () => {
    function prepareCapture(scrollY: number) {
      const sourceContext = mockCanvasContext()
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => sourceContext as unknown as CanvasRenderingContext2D,
      )
      const exportedCanvasSizes: string[] = []
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
        this: HTMLCanvasElement,
        callback: BlobCallback,
      ) {
        exportedCanvasSizes.push(`${this.width}x${this.height}`)
        callback(new Blob(['jpeg'], { type: 'image/jpeg' }))
      })
      vi.spyOn(document.body, 'clientWidth', 'get').mockReturnValue(1280)
      vi.spyOn(document.body, 'clientHeight', 'get').mockReturnValue(3000)
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720)
      vi.spyOn(window, 'scrollX', 'get').mockReturnValue(0)
      vi.spyOn(window, 'scrollY', 'get').mockReturnValue(scrollY)
      vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(rect(0, -scrollY, 1280, 3000))
      vi.stubGlobal('Image', ViewportImage)

      return { sourceContext, exportedCanvasSizes }
    }

    // Made near the top of the page, 360px down the viewport, with the page
    // still unscrolled — so the mark sits 360px into the document.
    const annotation = { type: 'pin' as const, x: 640, y: 360, captureOffsetX: 0, captureOffsetY: 0 }

    it('follows its content up the bitmap when the page scrolls a little', async () => {
      const { sourceContext } = prepareCapture(200)

      await captureScreenshot([annotation])

      // The document point at 360 sits 160px down a viewport scrolled to 200.
      expect(sourceContext.arc).toHaveBeenCalledWith(640, 160, 11, 0, Math.PI * 2)
    })

    // The capture is one viewport — the one on screen at capture time. A mark
    // whose content has been scrolled past the captured rect is honestly not in
    // the shot: its coordinates land off-canvas and the canvas clips them. The
    // wire annotation still carries the mark; only the bitmap omits it.
    it('omits a mark the page has scrolled out of the captured viewport', async () => {
      const { sourceContext, exportedCanvasSizes } = prepareCapture(1200)

      await captureScreenshot([annotation])

      // 360 into the document is 840px above a viewport scrolled to 1200.
      expect(sourceContext.arc).toHaveBeenCalledWith(640, -840, 11, 0, Math.PI * 2)
      // And the export must stay the whole captured viewport: chasing the mark
      // with a crop is what used to shift the remaining content and blank the
      // shot.
      expect(exportedCanvasSizes).toEqual(['1280x720'])
    })

    // Both scrolls at once, in opposite directions, so no single-term mistake
    // survives: the mark was made 350px down the viewport with the page at 200
    // and its container at 180, which puts it 730px down the clone. The page
    // has since moved to 500 — where the clone point 730 renders 230px down
    // the captured viewport — and the container is back at the top.
    it('holds its place when the page and the container it sits in both scroll', async () => {
      const { sourceContext } = prepareCapture(500)
      document.body.innerHTML = '<main id="scroller"><input id="target"></main>'

      await captureScreenshot([{
        type: 'pin', x: 600, y: 350, targetSelector: '#target',
        captureOffsetX: 0, captureOffsetY: 380,
      }])

      expect(sourceContext.arc).toHaveBeenCalledWith(600, 230, 11, 0, Math.PI * 2)
    })

    it('stays glued to the same document point whichever scroll the capture ran at', async () => {
      const anchored = { type: 'pin' as const, x: 640, y: 360, captureOffsetX: 0, captureOffsetY: 600 }
      const first = prepareCapture(600)
      await captureScreenshot([anchored])
      // Read before restoring: restoring clears what the mocks recorded.
      const firstY = first.sourceContext.arc.mock.calls[0]?.[1] as number
      vi.restoreAllMocks()
      const second = prepareCapture(400)
      await captureScreenshot([anchored])
      const secondY = second.sourceContext.arc.mock.calls[0]?.[1] as number

      // Bitmap position + capture scroll = the document point the reporter
      // marked; that sum must not depend on when the capture ran.
      expect(firstY).toBe(360)
      expect(firstY + 600).toBe(secondY + 400)
    })
  })

  describe('inside a nested scroller', () => {
    function prepareCapture() {
      const sourceContext = mockCanvasContext()
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => sourceContext as unknown as CanvasRenderingContext2D,
      )
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
        callback(new Blob(['jpeg'], { type: 'image/jpeg' }))
      })
      vi.spyOn(document.body, 'clientWidth', 'get').mockReturnValue(1280)
      vi.spyOn(document.body, 'clientHeight', 'get').mockReturnValue(720)
      vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        right: 1280,
        bottom: 720,
        left: 0,
        width: 1280,
        height: 720,
        toJSON: () => ({}),
      })
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720)
      vi.stubGlobal('Image', ViewportImage)

      document.body.innerHTML = '<main id="scroller"><input id="target"></main>'
      const scroller = document.querySelector<HTMLElement>('#scroller')!
      Object.defineProperty(scroller, 'scrollTop', { value: 180, configurable: true })

      return { sourceContext }
    }

    const targetRect = { top: 330, left: 500, width: 200, height: 40, bottom: 370 }

    it('moves a pin with its target when the target is inside a scrolled container', async () => {
      const { sourceContext } = prepareCapture()

      await captureScreenshot([{
        type: 'pin', x: 600, y: 350, targetSelector: '#target', targetRect,
      }])

      expect(sourceContext.arc).toHaveBeenCalledWith(600, 530, 11, 0, Math.PI * 2)
    })

    it('holds a pin at its target when the container scrolls after the annotation', async () => {
      const { sourceContext } = prepareCapture()
      // The reporter marked the target while the container sat at 180, then
      // scrolled it back to the top before submitting.
      const scroller = document.querySelector<HTMLElement>('#scroller')!
      Object.defineProperty(scroller, 'scrollTop', { value: 0, configurable: true })

      await captureScreenshot([{
        type: 'pin', x: 600, y: 350, targetSelector: '#target', targetRect,
        captureOffsetX: 0, captureOffsetY: 180,
      }])

      expect(sourceContext.arc).toHaveBeenCalledWith(600, 530, 11, 0, Math.PI * 2)
    })

    it('moves every point in a drawing with its target inside a scrolled container', async () => {
      const { sourceContext } = prepareCapture()

      await captureScreenshot([{
        type: 'draw', x: 620, y: 360, targetSelector: '#target', targetRect,
        drawPath: 'M 600 350 L 640 390',
      }])

      expect(sourceContext.moveTo).toHaveBeenCalledWith(600, 530)
      expect(sourceContext.lineTo).toHaveBeenCalledWith(640, 570)
    })

    // Same expected pixels as the drawing above, which is the point: whether
    // the container is still scrolled or has been put back, the stroke stays on
    // what it was drawn over.
    it('holds a drawing at its target when the container scrolls after the annotation', async () => {
      const { sourceContext } = prepareCapture()
      const scroller = document.querySelector<HTMLElement>('#scroller')!
      Object.defineProperty(scroller, 'scrollTop', { value: 0, configurable: true })

      await captureScreenshot([{
        type: 'draw', x: 620, y: 360, targetSelector: '#target', targetRect,
        drawPath: 'M 600 350 L 640 390',
        captureOffsetX: 0, captureOffsetY: 180,
      }])

      expect(sourceContext.moveTo).toHaveBeenCalledWith(600, 530)
      expect(sourceContext.lineTo).toHaveBeenCalledWith(640, 570)
    })

    // A scrolled container is where a painted cover used to need its own
    // scroll arithmetic; a mask inside the clone has nothing to compensate.
    it('masks rr-block regions, sensitive fields, and secret text inside a scrolled container', async () => {
      const { sourceContext } = prepareCapture()
      const scroller = document.querySelector<HTMLElement>('#scroller')!
      const blocked = document.createElement('section')
      blocked.className = 'rr-block'
      vi.spyOn(blocked, 'getBoundingClientRect').mockReturnValue(rect(100, 200, 300, 120))
      const password = document.createElement('input')
      password.type = 'password'
      password.value = 'hunter2'
      vi.spyOn(password, 'getBoundingClientRect').mockReturnValue(rect(500, 330, 200, 40))
      const secretText = document.createTextNode('Key sk-proj-abcdefghijklmnopqrstuvwxyz123456')
      scroller.append(blocked, password, secretText)

      await captureScreenshot()

      expect(clonedElement('#scroller > section.rr-block').getAttribute('data-mtb-mask')).toBe('block')
      expect(clonedElement('#scroller > input[type="password"]').getAttribute('data-mtb-mask')).toBe('field')
      expect(clonedElement('#scroller > span[data-mtb-mask="text"]').textContent).toBe('Key sk-proj-abcdefghijklmnopqrstuvwxyz123456')
      expect(sourceContext.fillRect).not.toHaveBeenCalled()
      expect(scroller.lastChild).toBe(secretText)
    })

    it('exports the whole viewport bitmap even when the scrolled annotation falls outside it', async () => {
      const exportedCanvasSizes: string[] = []
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
        this: HTMLCanvasElement,
        callback: BlobCallback,
      ) {
        exportedCanvasSizes.push(`${this.width}x${this.height}`)
        callback(new Blob(['jpeg'], { type: 'image/jpeg' }))
      })
      vi.spyOn(document.body, 'clientWidth', 'get').mockReturnValue(1920)
      vi.spyOn(document.body, 'clientHeight', 'get').mockReturnValue(1080)
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1080)
      vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1920, 1080))
      vi.stubGlobal('Image', DesktopViewportImage)

      document.body.innerHTML = '<main id="scroller"><input id="target"></main>'
      const scroller = document.querySelector<HTMLElement>('#scroller')!
      Object.defineProperty(scroller, 'scrollTop', { value: 632, configurable: true })

      await captureScreenshot([{
        type: 'pin',
        x: 876.67578125,
        y: 622.16796875,
        targetSelector: '#target',
        targetRect: { top: 613.5, left: 864.7265625, width: 20, bottom: 633.5, height: 20 },
      }])

      expect(exportedCanvasSizes).toEqual(['1920x1080'])
    })
  })

  it('passes resourceUrlResolver through to toJpeg when provided', async () => {
    const resolver = vi.fn()
    await captureBaseScreenshot(resolver)

    const options = toJpegMock.mock.calls[0]?.[1]
    expect(options).toHaveProperty('resourceUrlResolver', resolver)
  })

  it('omits resourceUrlResolver from toJpeg when not provided', async () => {
    await captureBaseScreenshot()

    const options = toJpegMock.mock.calls[0]?.[1]
    expect(options?.resourceUrlResolver).toBeUndefined()
  })
})

describe('parsePathPolylines', () => {
  it('parses a single M/L polyline', () => {
    expect(parsePathPolylines('M 10 20 L 30 40 L 50 60')).toEqual([
      [[10, 20], [30, 40], [50, 60]],
    ])
  })

  it('splits multiple strokes on M commands', () => {
    expect(parsePathPolylines('M 1 2 L 3 4 M 5 6 L 7 8')).toEqual([
      [[1, 2], [3, 4]],
      [[5, 6], [7, 8]],
    ])
  })

  it('handles decimals and negatives and ignores junk', () => {
    expect(parsePathPolylines('M 1.5 -2.25 L -3 4.75 Z garbage')).toEqual([
      [[1.5, -2.25], [-3, 4.75]],
    ])
  })

  it('returns no polylines for an empty path', () => {
    expect(parsePathPolylines('')).toEqual([])
  })
})

class ImmediatelyLoadingImage {
  naturalWidth = 1280
  naturalHeight = 3000
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

class ViewportImage {
  naturalWidth = 1280
  naturalHeight = 720
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

class DesktopViewportImage {
  naturalWidth = 1920
  naturalHeight = 1080
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

function mockCanvasContext() {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    stroke: vi.fn(),
  }
}

function trackStyleAssignments(
  context: ReturnType<typeof mockCanvasContext>,
  property: 'fillStyle' | 'shadowColor' | 'strokeStyle',
): string[] {
  const values: string[] = []
  Object.defineProperty(context, property, {
    configurable: true,
    get: () => values[values.length - 1],
    set: (value: string) => values.push(value),
  })
  return values
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  }
}
