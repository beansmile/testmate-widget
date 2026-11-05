import { afterEach, describe, expect, it, vi } from 'vitest'
import { anchorScreenshotOffset, captureAnchorOffset, nestedScrollOffset } from './geometry'

function setScroll(element: Element, top: number, left = 0): void {
  Object.defineProperty(element, 'scrollTop', { value: top, configurable: true })
  Object.defineProperty(element, 'scrollLeft', { value: left, configurable: true })
}

function setScrollingElement(element: Element | null): void {
  Object.defineProperty(document, 'scrollingElement', { value: element, configurable: true })
}

describe('nestedScrollOffset', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    setScroll(document.body, 0)
    setScroll(document.documentElement, 0)
    setScrollingElement(document.documentElement)
    vi.restoreAllMocks()
  })

  it('adds up every scrolled container between the element and the page', () => {
    document.body.innerHTML = '<main id="outer"><div id="inner"><span id="target"></span></div></main>'
    setScroll(document.querySelector('#outer')!, 50, 4)
    setScroll(document.querySelector('#inner')!, 30)

    expect(nestedScrollOffset(document.querySelector('#target'))).toEqual({ x: 4, y: 80 })
  })

  // The app-shell layout `html { overflow: hidden } body { overflow: auto }`
  // makes the body its own scroller: window.scrollY stays 0 while the body's
  // scrollTop moves the content, and html-to-image renders the body
  // unscrolled. Stopping at the body dropped that scroll, so every mark and
  // privacy cover on such a page landed body.scrollTop away from its target
  // (300px in the browser reproduction).
  it('counts the body when the body scrolls on its own', () => {
    setScrollingElement(document.documentElement)
    document.body.innerHTML = '<span id="target"></span>'
    setScroll(document.body, 300)

    expect(nestedScrollOffset(document.querySelector('#target'))).toEqual({ x: 0, y: 300 })
  })

  // In quirks mode the body IS the page: its scrollTop mirrors window.scrollY,
  // which the capture frame already compensates. Counting it would apply the
  // page scroll twice.
  it('leaves the body out when it is the document scrolling element', () => {
    setScrollingElement(document.body)
    document.body.innerHTML = '<span id="target"></span>'
    setScroll(document.body, 300)

    expect(nestedScrollOffset(document.querySelector('#target'))).toEqual({ x: 0, y: 0 })
  })

  it('never counts the document element, whose scroll is the page scroll', () => {
    setScrollingElement(document.documentElement)
    document.body.innerHTML = '<span id="target"></span>'
    setScroll(document.documentElement, 500)

    expect(nestedScrollOffset(document.querySelector('#target'))).toEqual({ x: 0, y: 0 })
  })
})

describe('captureAnchorOffset', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    setScroll(document.body, 0)
    setScrollingElement(document.documentElement)
    vi.restoreAllMocks()
  })

  it('carries a body scroll into the anchor, and the bake keeps it because the page scroll is 0', () => {
    setScrollingElement(document.documentElement)
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(0)
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(0)
    document.body.innerHTML = '<span id="target"></span>'
    setScroll(document.body, 48)

    const anchor = captureAnchorOffset(document.querySelector('#target'))

    expect(anchor).toEqual({ x: 0, y: 48 })
    expect(anchorScreenshotOffset(anchor, { x: 0, y: 0 })).toEqual({ x: 0, y: 48 })
  })
})
