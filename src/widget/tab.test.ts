import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedbackTab } from './tab'
import { ShadowContainer } from './shadow'
import { getMessages } from '../i18n'

function setupTab(
  position: 'left' | 'right' = 'right',
  customText?: string,
) {
  const shadow = new ShadowContainer()
  const onClick = vi.fn()
  const messages = getMessages('en')
  const tab = new FeedbackTab(shadow, messages, position, onClick, customText)

  return { shadow, tab, onClick, messages }
}

describe('FeedbackTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders button with feedback text', () => {
    const { shadow, tab, messages } = setupTab()

    const btn = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')
    expect(btn).toBeTruthy()
    expect(btn!.textContent).toBe(messages.tab)
    expect(btn!.getAttribute('aria-label')).toBe(messages.tab)

    tab.destroy()
    shadow.destroy()
  })

  it('renders custom text and keeps it when the locale changes', () => {
    const { shadow, tab } = setupTab('right', 'Report an issue')
    const btn = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!

    expect(btn.textContent).toBe('Report an issue')
    tab.setMessages(getMessages('zh-CN'))
    expect(btn.textContent).toBe('Report an issue')

    tab.destroy()
    shadow.destroy()
  })

  it('positions on right by default (no left class)', () => {
    const { shadow, tab } = setupTab('right')

    const btn = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!
    expect(btn.classList.contains('left')).toBe(false)

    tab.destroy()
    shadow.destroy()
  })

  it('adds left class when position is left', () => {
    const { shadow, tab } = setupTab('left')

    const btn = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!
    expect(btn.classList.contains('left')).toBe(true)

    tab.destroy()
    shadow.destroy()
  })

  it('calls onClick when button is clicked', () => {
    const { shadow, tab, onClick } = setupTab()

    shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!.click()
    expect(onClick).toHaveBeenCalledOnce()

    tab.destroy()
    shadow.destroy()
  })

  it('setActive toggles active class', () => {
    const { shadow, tab } = setupTab()
    const btn = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!

    tab.setActive(true)
    expect(btn.classList.contains('active')).toBe(true)

    tab.setActive(false)
    expect(btn.classList.contains('active')).toBe(false)

    tab.destroy()
    shadow.destroy()
  })

  it('setActive swaps label to exit text and back', () => {
    const { shadow, tab, messages } = setupTab()
    const btn = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!

    tab.setActive(true)
    expect(btn.textContent).toBe(messages.toolbar.exit)
    expect(btn.getAttribute('aria-label')).toBe(messages.toolbar.exit)

    tab.setActive(false)
    expect(btn.textContent).toBe(messages.tab)

    tab.destroy()
    shadow.destroy()
  })

  it('destroy removes element from shadow root', () => {
    const { shadow, tab } = setupTab()

    expect(shadow.root.querySelector('.mtb-tab')).toBeTruthy()
    tab.destroy()
    expect(shadow.root.querySelector('.mtb-tab')).toBeNull()

    shadow.destroy()
  })

  it('destroy removes click listener', () => {
    const { shadow, tab, onClick } = setupTab()

    tab.destroy()
    const btn = shadow.root.querySelector('.mtb-tab')
    expect(btn).toBeNull()
    expect(onClick).not.toHaveBeenCalled()

    shadow.destroy()
  })
  // The phone form is pure CSS keyed on viewport width, so the button mounts
  // at every width — the old width-keyed unmount is gone with the no-launcher
  // policy it served.
  it.each([393, 480, 1024])('mounts exactly one button at %ipx', (width) => {
    vi.stubGlobal('innerWidth', width)
    const { shadow, tab, onClick } = setupTab()

    const buttons = shadow.root.querySelectorAll<HTMLButtonElement>('.mtb-tab')
    expect(buttons).toHaveLength(1)
    window.dispatchEvent(new Event('resize'))
    expect(shadow.root.querySelectorAll('.mtb-tab')).toHaveLength(1)
    buttons[0].click()
    expect(onClick).toHaveBeenCalledOnce()

    tab.destroy()
    shadow.destroy()
  })

  it('carries a launch icon and an exit icon for the phone form', () => {
    const { shadow, tab, messages } = setupTab()
    const button = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!

    expect(button.querySelector('.mtb-tab-icon-launch')).not.toBeNull()
    expect(button.querySelector('.mtb-tab-icon-exit')).not.toBeNull()
    expect(button.querySelector('.mtb-tab-icon')!.getAttribute('aria-hidden')).toBe('true')
    // The icons add no text: the accessible name is still the label alone.
    expect(button.textContent).toBe(messages.tab)

    tab.setActive(true)
    expect(button.textContent).toBe(messages.toolbar.exit)
    expect(button.getAttribute('aria-label')).toBe(messages.toolbar.exit)

    tab.destroy()
    shadow.destroy()
  })

  // The chat card and the frustration prompt are full-width bottom sheets on a
  // phone, docked to the launcher's corner. The class is what the narrow-width
  // CSS keys on to hide the launcher for exactly as long as one is up.
  it.each(['mtb-chat', 'mtb-frustration-prompt'])('yields while a .%s surface is mounted', async (cls) => {
    const { shadow, tab } = setupTab()
    const button = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!
    expect(button.classList.contains('mtb-tab--yielding')).toBe(false)

    const surface = shadow.el('div', cls)
    shadow.append(surface)
    await vi.waitFor(() => expect(button.classList.contains('mtb-tab--yielding')).toBe(true))

    shadow.remove(surface)
    await vi.waitFor(() => expect(button.classList.contains('mtb-tab--yielding')).toBe(false))

    tab.destroy()
    shadow.destroy()
  })

  it('yields from the start when mounted under an open surface', () => {
    const shadow = new ShadowContainer()
    shadow.append(shadow.el('div', 'mtb-chat'))
    const tab = new FeedbackTab(shadow, getMessages('en'), 'right', vi.fn())

    expect(shadow.root.querySelector('.mtb-tab')!.classList.contains('mtb-tab--yielding')).toBe(true)

    tab.destroy()
    shadow.destroy()
  })

  it('stops watching the shadow root once destroyed', async () => {
    const { shadow, tab } = setupTab()
    const button = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!
    tab.destroy()

    shadow.append(shadow.el('div', 'mtb-chat'))
    await Promise.resolve()
    expect(button.classList.contains('mtb-tab--yielding')).toBe(false)

    shadow.destroy()
  })

})

describe('FeedbackTab button type', () => {
  it('is a plain button that never submits an enclosing form', () => {
    const shadow = new ShadowContainer()
    const onClick = vi.fn()
    const tab = new FeedbackTab(shadow, getMessages('en'), 'right', onClick)
    const btn = shadow.root.querySelector<HTMLButtonElement>('.mtb-tab')!

    expect(btn.type).toBe('button')
    btn.click()
    expect(onClick).toHaveBeenCalledTimes(1)

    tab.destroy()
    shadow.destroy()
  })
})
