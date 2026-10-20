import { afterEach, describe, it, expect, vi } from 'vitest'
import { ShadowContainer } from '../widget/shadow'
import { DrawNoteBar } from './draw-note-bar'
import { getMessages } from '../i18n'

describe('DrawNoteBar', () => {
  let shadow: ShadowContainer
  let bar: DrawNoteBar

  function setup() {
    shadow = new ShadowContainer()
    const handlers = {
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
    }
    bar = new DrawNoteBar(shadow, { messages: getMessages('en'), ...handlers })
    return handlers
  }

  afterEach(() => {
    bar.destroy()
    shadow.destroy()
    document.body.innerHTML = ''
  })

  // A drawing is strokes baked onto the screenshot, so there is no opting out
  // here — but the reporter is still told the screenshot is going with it.
  it('discloses the screenshot without offering a choice', () => {
    setup()
    const box = shadow.root.querySelector<HTMLInputElement>('.mtb-draw-shot input')!
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(true)
    expect(shadow.root.querySelector('.mtb-draw-shot span')!.textContent)
      .toBe(getMessages('en').popup.screenshot_short)
  })

  it('renders the screenshot label as text, never as markup', () => {
    shadow = new ShadowContainer()
    const messages = structuredClone(getMessages('en'))
    const payload = '<img src=x onerror="window.widgetXss=true">'
    messages.popup.screenshot_short = payload
    messages.popup.screenshot_locked_hint = payload
    bar = new DrawNoteBar(shadow, {
      messages,
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
    })

    expect(shadow.root.querySelector('.mtb-draw-shot span')!.textContent).toBe(payload)
    expect(shadow.root.querySelector('.mtb-draw-shot img')).toBeNull()
  })

  it('renders note input, undo, redo, cancel and submit', () => {
    setup()
    expect(shadow.root.querySelector('.mtb-draw-input')).toBeTruthy()
    expect(shadow.root.querySelector('.mtb-draw-undo')).toBeTruthy()
    expect(shadow.root.querySelector('.mtb-draw-redo')).toBeTruthy()
    expect(shadow.root.querySelector('.mtb-draw-cancel')!.textContent).toBe(getMessages('en').draw.cancel)
    expect(shadow.root.querySelector('.mtb-draw-submit')!.textContent).toBe(getMessages('en').draw.submit)
  })

  it('disables undo and redo by default', () => {
    setup()
    expect(shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-undo')!.disabled).toBe(true)
    expect(shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-redo')!.disabled).toBe(true)
  })

  it('setUndoRedo toggles the button disabled state', () => {
    setup()
    bar.setUndoRedo(true, false)
    expect(shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-undo')!.disabled).toBe(false)
    expect(shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-redo')!.disabled).toBe(true)
  })

  it('fires callbacks for undo, redo and cancel', () => {
    const handlers = setup()
    shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-undo')!.disabled = false
    shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-undo')!.click()
    shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-redo')!.disabled = false
    shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-redo')!.click()
    shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-cancel')!.click()
    expect(handlers.onUndo).toHaveBeenCalledOnce()
    expect(handlers.onRedo).toHaveBeenCalledOnce()
    expect(handlers.onCancel).toHaveBeenCalledOnce()
  })

  it('submits the trimmed note via click (no keydown)', () => {
    const handlers = setup()
    const input = shadow.root.querySelector<HTMLInputElement>('.mtb-draw-input')!
    input.value = '  fix this  '
    shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-submit')!.click()
    expect(handlers.onSubmit).toHaveBeenCalledWith('fix this', [])
  })

  it('submits an empty string when the note is blank', () => {
    const handlers = setup()
    shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-submit')!.click()
    expect(handlers.onSubmit).toHaveBeenCalledWith('', [])
  })

  it('Enter submits the note text', () => {
    const handlers = setup()
    const input = shadow.root.querySelector<HTMLInputElement>('.mtb-draw-input')!
    input.value = 'broken export'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(handlers.onSubmit).toHaveBeenCalledWith('broken export', [])
  })

  describe('attached images', () => {
    const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })

    function setupWithAttachments() {
      shadow = new ShadowContainer()
      const handlers = { onUndo: vi.fn(), onRedo: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn() }
      bar = new DrawNoteBar(shadow, { messages: getMessages('en'), attachments: true, ...handlers })
      return handlers
    }

    function pick(files: File[]): void {
      const input = shadow.root.querySelector<HTMLInputElement>('.mtb-draw-attach-input')!
      Object.defineProperty(input, 'files', { value: files, configurable: true })
      input.dispatchEvent(new Event('change'))
    }

    it('has no paperclip unless asked for', () => {
      setup()
      expect(shadow.root.querySelector('.mtb-draw-attach')).toBeNull()
    })

    it('passes picked images through to submit and shows their count', async () => {
      const handlers = setupWithAttachments()
      pick([png('hero.png'), png('logo.png')])
      const chip = shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-attach-count')!
      await vi.waitFor(() => expect(chip.hidden).toBe(false))
      expect(chip.textContent).toContain('2/5')

      shadow.root.querySelector<HTMLInputElement>('.mtb-draw-input')!.value = 'use these'
      shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-submit')!.click()
      const [note, files] = handlers.onSubmit.mock.calls[0] as [string, File[]]
      expect(note).toBe('use these')
      expect(files.map(f => f.name)).toEqual(['hero.png', 'logo.png'])
    })

    it('clears every image from the count chip', async () => {
      const handlers = setupWithAttachments()
      pick([png('hero.png')])
      const chip = shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-attach-count')!
      await vi.waitFor(() => expect(chip.hidden).toBe(false))
      chip.click()
      expect(chip.hidden).toBe(true)
      shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-submit')!.click()
      expect(handlers.onSubmit).toHaveBeenCalledWith('', [])
    })

    it('caps the set at five and says so', async () => {
      setupWithAttachments()
      pick(['a', 'b', 'c', 'd', 'e', 'f'].map(n => png(`${n}.png`)))
      const error = shadow.root.querySelector<HTMLSpanElement>('.mtb-draw-attach-error')!
      await vi.waitFor(() => expect(error.hidden).toBe(false))
      expect(error.textContent).toBe('Up to 5 images')
      expect(shadow.root.querySelector<HTMLButtonElement>('.mtb-draw-attach')!.disabled).toBe(true)
    })
  })

  // This bar was unreachable on a phone until freehand drawing started
  // working. It sits flush to the bottom there and carries a text field, so
  // the keyboard lands squarely on top of it.
  describe('narrow viewport', () => {
    function narrow(vpHeight: number) {
      Object.defineProperty(window, 'innerWidth', { value: 393, configurable: true, writable: true })
      Object.defineProperty(window, 'innerHeight', { value: 852, configurable: true, writable: true })
      Object.defineProperty(window, 'visualViewport', {
        value: { height: vpHeight, offsetTop: 0, addEventListener() {}, removeEventListener() {} },
        configurable: true,
        writable: true,
      })
    }

    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true })
      Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true, writable: true })
    })

    it('sits above an open keyboard', () => {
      narrow(561)
      setup()
      expect(shadow.root.querySelector<HTMLElement>('.mtb-draw-bar')!.style.bottom).toBe('291px')
    })

    it('stays put when no keyboard is open', () => {
      narrow(852)
      setup()
      expect(shadow.root.querySelector<HTMLElement>('.mtb-draw-bar')!.style.bottom).toBe('')
    })
  })
})
