import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPopup } from './chat-popup'
import { ShadowContainer } from '../widget/shadow'
import { getMessages } from '../i18n'
import type { ClarifyStreamResult } from '../api/client'
import type { SubmissionSessionResponse } from '../types'

function makeSession(overrides?: Partial<SubmissionSessionResponse>): SubmissionSessionResponse {
  return { id: 'sub_1', token: 'tok', ai_clarify_available: true, ...overrides }
}

function makeResult(overrides?: Partial<ClarifyStreamResult>): ClarifyStreamResult {
  return {
    done: false,
    suggestions: [],
    messages: [{ role: 'assistant', content: 'What went wrong?' }],
    ...overrides,
  }
}

function mountPopup(overrides: Record<string, unknown> = {}) {
  const shadow = new ShadowContainer()
  const messages = getMessages('en')
  const defaults: Record<string, unknown> = {
    targetName: 'Button',
    x: 100,
    y: 100,
    messages,
    onSubmit: vi.fn().mockResolvedValue(makeSession()),
    onClarify: vi.fn().mockResolvedValue(makeResult()),
    onAnswer: vi.fn().mockResolvedValue(undefined),
    onFinalize: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
  }
  const opts = { ...defaults, ...overrides }
  const popup = new ChatPopup(shadow, opts as unknown as ConstructorParameters<typeof ChatPopup>[1])
  return { shadow, popup, opts }
}

describe('ChatPopup streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows streaming bubble immediately on first delta, not after stream ends', async () => {
    let emitDelta!: (text: string) => void
    const onClarify = vi.fn((_id: string, _tok: string, onDelta: (d: string) => void) => {
      emitDelta = onDelta
      return new Promise<ClarifyStreamResult>(() => {})
    })
    const { shadow, popup } = mountPopup({ onClarify })
    popup.submit('test')

    await vi.waitFor(() => expect(onClarify).toHaveBeenCalled())

    expect(shadow.root.querySelector('.mtb-chat-bubble-ai')).toBeNull()

    emitDelta('Hello')

    expect(shadow.root.querySelector('.mtb-chat-bubble-ai')).toBeTruthy()
    expect(shadow.root.querySelector('.mtb-chat-bubble-ai')!.textContent).toBe('Hello')

    emitDelta(' world')
    expect(shadow.root.querySelector('.mtb-chat-bubble-ai')!.textContent).toBe('Hello world')

    popup.destroy()
    shadow.destroy()
  })

  it('skips streaming bubble when done:true and shows receipt directly', async () => {
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup } = mountPopup({ onClarify })

    popup.submit('clear feedback')

    await vi.waitFor(() => {
      expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy()
    })

    expect(shadow.root.querySelector('.mtb-chat-bubble-ai')).toBeNull()

    popup.destroy()
    shadow.destroy()
  })

  it('auto-closes a finalized receipt after three seconds when there is no capture card', async () => {
    vi.useFakeTimers()
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup, opts } = mountPopup({
      onClarify,
      resolveEmailCapture: () => undefined,
    })

    popup.submit('clear feedback')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())
    await Promise.resolve()
    await Promise.resolve()

    popup.showFinalizeSuccess()
    expect(shadow.root.querySelector('.mtb-chat-email-card')).toBeNull()

    await vi.advanceTimersByTimeAsync(2_999)
    expect(shadow.root.querySelector('.mtb-chat')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(1)
    expect(shadow.root.querySelector('.mtb-chat')).toBeNull()
    expect(opts['onCancel']).not.toHaveBeenCalled()

    shadow.destroy()
    vi.useRealTimers()
  })

  it('never auto-closes while the capture card is waiting for the reporter', async () => {
    vi.useFakeTimers()
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup, opts } = mountPopup({
      onClarify,
      resolveEmailCapture: () => ({ onSubmit: vi.fn().mockResolvedValue(true) }),
    })

    popup.submit('clear feedback')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())
    await Promise.resolve()
    await Promise.resolve()

    popup.showFinalizeSuccess()
    expect(shadow.root.querySelector('.mtb-chat-email-card')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(shadow.root.querySelector('.mtb-chat')).toBeTruthy()
    expect(shadow.root.querySelector('.mtb-chat-email-input')).toBeTruthy()
    expect(opts['onCancel']).not.toHaveBeenCalled()

    popup.destroy()
    shadow.destroy()
    vi.useRealTimers()
  })

  it('still closes from the × button while the capture card is showing', async () => {
    vi.useFakeTimers()
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup, opts } = mountPopup({
      onClarify,
      resolveEmailCapture: () => ({ onSubmit: vi.fn().mockResolvedValue(true) }),
    })

    popup.submit('clear feedback')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())
    popup.showFinalizeSuccess()
    expect(shadow.root.querySelector('.mtb-chat-email-card')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(10_000)
    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-close')!.click()
    expect(opts['onCancel']).toHaveBeenCalledTimes(1)

    popup.destroy()
    shadow.destroy()
    vi.useRealTimers()
  })

  it('still closes from Escape while the capture card is showing', async () => {
    vi.useFakeTimers()
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup } = mountPopup({
      onClarify,
      resolveEmailCapture: () => ({ onSubmit: vi.fn().mockResolvedValue(true) }),
    })

    popup.submit('clear feedback')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())
    popup.showFinalizeSuccess()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(shadow.root.querySelector('.mtb-chat')).toBeTruthy()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(shadow.root.querySelector('.mtb-chat')).toBeNull()

    shadow.destroy()
    vi.useRealTimers()
  })

  it('saves a name alone from the capture card', async () => {
    const save = vi.fn().mockResolvedValue(true)
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup } = mountPopup({
      onClarify,
      resolveEmailCapture: () => ({ onSubmit: save }),
    })

    popup.submit('clear feedback')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())
    popup.showFinalizeSuccess()

    const nameInput = shadow.root.querySelector<HTMLInputElement>('.mtb-chat-name-input')!
    const btn = shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-email-submit')!
    expect(shadow.root.querySelector('.mtb-chat-name-label-text')!.textContent).toBe('Name (optional)')
    expect(nameInput.placeholder).toBe('Your name')
    expect(btn.disabled).toBe(true)

    nameInput.value = '  Ada  '
    nameInput.dispatchEvent(new Event('input'))
    expect(btn.disabled).toBe(false)
    btn.click()

    expect(save).toHaveBeenCalledWith({ name: 'Ada' })
    await vi.waitFor(() => {
      expect(shadow.root.querySelector('.mtb-chat-email-note')!.textContent).toBe("Thanks, we've saved your name.")
    })
    shadow.destroy()
  })

  it('sends name and email together and prefills remembered values', async () => {
    const save = vi.fn().mockResolvedValue(true)
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup } = mountPopup({
      onClarify,
      resolveEmailCapture: () => ({ initial: { name: 'Ada' }, onSubmit: save }),
    })

    popup.submit('clear feedback')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())
    popup.showFinalizeSuccess()

    const nameInput = shadow.root.querySelector<HTMLInputElement>('.mtb-chat-name-input')!
    const emailInput = shadow.root.querySelector<HTMLInputElement>('.mtb-chat-email-input')!
    expect(nameInput.value).toBe('Ada')
    expect(emailInput.value).toBe('')

    emailInput.value = 'ada@example.com'
    emailInput.dispatchEvent(new Event('input'))
    emailInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

    expect(save).toHaveBeenCalledWith({ name: 'Ada', email: 'ada@example.com' })
    shadow.destroy()
  })

  it('pauses auto-close while email is being filled and saved', async () => {
    vi.useFakeTimers()
    let resolveSave!: (saved: boolean) => void
    const saveEmail = vi.fn(() => new Promise<boolean>(resolve => { resolveSave = resolve }))
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup } = mountPopup({
      onClarify,
      resolveEmailCapture: () => ({ onSubmit: saveEmail }),
    })

    popup.submit('clear feedback')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())
    await Promise.resolve()
    await Promise.resolve()

    popup.showFinalizeSuccess()
    const emailInput = shadow.root.querySelector<HTMLInputElement>('.mtb-chat-email-input')!
    emailInput.focus()
    emailInput.value = 'anon@example.com'
    emailInput.dispatchEvent(new Event('input'))

    await vi.advanceTimersByTimeAsync(3_000)
    expect(shadow.root.querySelector('.mtb-chat')).toBeTruthy()

    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-email-submit')!.click()
    expect(saveEmail).toHaveBeenCalledWith({ email: 'anon@example.com' })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(shadow.root.querySelector('.mtb-chat')).toBeTruthy()

    resolveSave(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(shadow.root.querySelector('.mtb-chat-email-note')).toBeTruthy()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(shadow.root.querySelector('.mtb-chat')).toBeTruthy()
    await vi.advanceTimersByTimeAsync(1)
    expect(shadow.root.querySelector('.mtb-chat')).toBeNull()

    shadow.destroy()
    vi.useRealTimers()
  })

  it('passes AbortSignal to onClarify', async () => {
    const onClarify = vi.fn((_id: string, _tok: string, _delta: unknown, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return Promise.resolve(makeResult())
    })
    const { shadow, popup } = mountPopup({ onClarify })
    popup.submit('test')

    await vi.waitFor(() => expect(onClarify).toHaveBeenCalled())
    expect(onClarify.mock.calls[0][3]).toBeInstanceOf(AbortSignal)

    popup.destroy()
    shadow.destroy()
  })

  it('aborts the SSE stream when destroyed', async () => {
    let signal: AbortSignal | undefined
    const onClarify = vi.fn((_id: string, _tok: string, _delta: unknown, s: AbortSignal) => {
      signal = s
      return new Promise<ClarifyStreamResult>(() => {})
    })
    const { shadow, popup } = mountPopup({ onClarify })
    popup.submit('test')

    await vi.waitFor(() => expect(onClarify).toHaveBeenCalled())
    expect(signal?.aborted).toBe(false)

    popup.destroy()
    expect(signal?.aborted).toBe(true)

    shadow.destroy()
  })
})

describe('ChatPopup finalize failure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows failure state in the receipt card', async () => {
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup } = mountPopup({ onClarify })

    popup.submit('test')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())

    const retry = vi.fn()
    popup.showFinalizeFailure(retry)

    expect(shadow.root.querySelector('.mtb-chat-finalize-failure')).toBeTruthy()
    expect(shadow.root.querySelector('.mtb-chat-finalize-retry')).toBeTruthy()

    popup.destroy()
    shadow.destroy()
  })

  it('creates failure container when receipt does not exist yet', async () => {
    const { shadow, popup } = mountPopup()

    popup.showFinalizeFailure()

    expect(shadow.root.querySelector('.mtb-chat-finalize-failure')).toBeTruthy()
    expect(shadow.root.querySelector('.mtb-chat-finalize-retry')).toBeNull()

    popup.destroy()
    shadow.destroy()
  })

  it('does not auto-close while failure card is showing', async () => {
    vi.useFakeTimers()
    const onFinalize = vi.fn().mockResolvedValue(undefined)
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const onCancel = vi.fn()
    const { shadow, popup } = mountPopup({ onClarify, onFinalize, onCancel })

    popup.submit('test')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())

    popup.showFinalizeFailure(vi.fn())
    expect(shadow.root.querySelector('.mtb-chat-finalize-failure')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(shadow.root.querySelector('.mtb-chat-finalize-failure')).toBeTruthy()
    expect(onCancel).not.toHaveBeenCalled()

    vi.useRealTimers()
    popup.destroy()
    shadow.destroy()
  })

  it('restores receipt after showFinalizeSuccess', async () => {
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup } = mountPopup({ onClarify })

    popup.submit('test')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())

    popup.showFinalizeFailure(vi.fn())
    expect(shadow.root.querySelector('.mtb-chat-finalize-failure')).toBeTruthy()

    popup.showFinalizeSuccess()
    expect(shadow.root.querySelector('.mtb-chat-finalize-failure')).toBeNull()
    expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy()

    popup.destroy()
    shadow.destroy()
  })
})

describe('ChatPopup category chips', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function chips(shadow: ShadowContainer) {
    return [...shadow.root.querySelectorAll<HTMLButtonElement>('.mtb-chat-qr')]
  }

  function type(shadow: ShadowContainer, text: string) {
    const input = shadow.root.querySelector<HTMLTextAreaElement>('.mtb-chat-input')!
    input.value = text
    input.dispatchEvent(new Event('input'))
    return input
  }

  it('selects a chip without submitting or clobbering what was typed', async () => {
    const { shadow, popup, opts } = mountPopup()
    const input = type(shadow, 'The save button does nothing')
    const [broken] = chips(shadow)

    broken!.click()
    await Promise.resolve()

    expect(opts['onSubmit']).not.toHaveBeenCalled()
    expect(broken!.getAttribute('aria-pressed')).toBe('true')
    expect(input.value).toBe('The save button does nothing')
    expect(shadow.root.querySelector('.mtb-chat-bubble-user')).toBeNull()
    expect(shadow.root.querySelector<HTMLElement>('.mtb-chat-quick-replies')!.style.display).not.toBe('none')

    popup.destroy()
    shadow.destroy()
  })

  it('does not submit when a chip is activated from the keyboard', async () => {
    const { shadow, popup, opts } = mountPopup()
    type(shadow, 'Something')
    const [, suggestion] = chips(shadow)

    suggestion!.focus()
    for (const key of ['Enter', ' ']) {
      suggestion!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }))
      suggestion!.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, composed: true }))
    }
    await Promise.resolve()

    expect(opts['onSubmit']).not.toHaveBeenCalled()
    popup.destroy()
    shadow.destroy()
  })

  it('keeps one chip selected at a time and toggles off on a second click', () => {
    const { shadow, popup, opts } = mountPopup()
    const [broken, suggestion] = chips(shadow)

    broken!.click()
    suggestion!.click()
    expect(chips(shadow).map(c => c.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])

    suggestion!.click()
    expect(chips(shadow).map(c => c.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false'])
    expect(opts['onSubmit']).not.toHaveBeenCalled()

    popup.destroy()
    shadow.destroy()
  })

  it('sends once from the Send button, prefixed with the selected category', async () => {
    const { shadow, popup, opts } = mountPopup()
    type(shadow, 'The save button does nothing')
    chips(shadow)[0]!.click()

    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-send')!.click()

    await vi.waitFor(() => expect(opts['onSubmit']).toHaveBeenCalledTimes(1))
    expect(opts['onSubmit']).toHaveBeenCalledWith("Something's broken: The save button does nothing", [])
    popup.destroy()
    shadow.destroy()
  })

  it('lets a selected chip alone be sent, but only from Send', async () => {
    const { shadow, popup, opts } = mountPopup()
    const send = shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-send')!
    expect(send.disabled).toBe(true)

    chips(shadow)[2]!.click()
    expect(send.disabled).toBe(false)
    expect(opts['onSubmit']).not.toHaveBeenCalled()

    chips(shadow)[2]!.click()
    expect(send.disabled).toBe(true)

    chips(shadow)[2]!.click()
    send.click()
    await vi.waitFor(() => expect(opts['onSubmit']).toHaveBeenCalledWith("I'm confused", []))
    popup.destroy()
    shadow.destroy()
  })

  it('does not submit from the screenshot toggle or the close button', async () => {
    const onScreenshotToggle = vi.fn()
    const { shadow, popup, opts } = mountPopup({ onScreenshotToggle })
    type(shadow, 'Something')

    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-screenshot')!.click()
    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-close')!.click()
    await Promise.resolve()

    expect(onScreenshotToggle).toHaveBeenCalledWith(false)
    expect(opts['onCancel']).toHaveBeenCalledTimes(1)
    expect(opts['onSubmit']).not.toHaveBeenCalled()
    popup.destroy()
    shadow.destroy()
  })

  it('declares every button as type="button" so none can act as a form submit', () => {
    const { shadow, popup } = mountPopup({ onScreenshotToggle: vi.fn() })
    const buttons = [...shadow.root.querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) expect(button.getAttribute('type')).toBe('button')
    popup.destroy()
    shadow.destroy()
  })

  it('Enter in the capture card saves the details without re-sending the feedback', async () => {
    const save = vi.fn().mockResolvedValue(true)
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup, opts } = mountPopup({
      onClarify,
      resolveEmailCapture: () => ({ onSubmit: save }),
    })

    type(shadow, 'clear feedback')
    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-send')!.click()
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())
    popup.showFinalizeSuccess()

    const nameInput = shadow.root.querySelector<HTMLInputElement>('.mtb-chat-name-input')!
    nameInput.value = 'Ada'
    nameInput.dispatchEvent(new Event('input'))
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }))
    await Promise.resolve()

    expect(save).toHaveBeenCalledTimes(1)
    expect(opts['onSubmit']).toHaveBeenCalledTimes(1)
    shadow.destroy()
  })
})

describe('ChatPopup attachments', () => {
  let urls = 0
  const revoked: string[] = []

  beforeEach(() => {
    urls = 0
    revoked.length = 0
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:mock/${++urls}`),
      revokeObjectURL: vi.fn((url: string) => { revoked.push(url) }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })

  function type(shadow: ShadowContainer, text: string) {
    const input = shadow.root.querySelector<HTMLTextAreaElement>('.mtb-chat-input')!
    input.value = text
    input.dispatchEvent(new Event('input'))
  }

  function pick(shadow: ShadowContainer, files: File[]): void {
    const input = shadow.root.querySelector<HTMLInputElement>('.mtb-chat-attach-input')!
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    input.dispatchEvent(new Event('change'))
  }

  const thumbs = (shadow: ShadowContainer) => Array.from(shadow.root.querySelectorAll<HTMLElement>('.mtb-chat-thumb'))
  const errorText = (shadow: ShadowContainer) => {
    const el = shadow.root.querySelector<HTMLElement>('.mtb-chat-attach-error')!
    return el.hidden ? '' : el.textContent
  }

  it('has no paperclip unless enabled', () => {
    const { shadow, popup } = mountPopup()
    expect(shadow.root.querySelector('.mtb-chat-attach')).toBeNull()
    expect(shadow.root.querySelector('.mtb-chat-attach-input')).toBeNull()
    popup.destroy()
    shadow.destroy()
  })

  it('renders an accessible paperclip with a hidden, untabbable image picker', () => {
    const { shadow, popup } = mountPopup({ attachments: true })
    const button = shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-attach')!
    expect(button.getAttribute('aria-label')).toBe('Attach images')
    const input = shadow.root.querySelector<HTMLInputElement>('.mtb-chat-attach-input')!
    expect(input.type).toBe('file')
    expect(input.multiple).toBe(true)
    expect(input.accept).toBe('image/png,image/jpeg,image/webp,image/gif')
    expect(input.hidden).toBe(true)
    const clicked = vi.spyOn(input, 'click').mockImplementation(() => {})
    button.click()
    expect(clicked).toHaveBeenCalled()
    popup.destroy()
    shadow.destroy()
  })

  it('shows thumbnails with a counter, removes one, and sends the rest', async () => {
    const { shadow, popup, opts } = mountPopup({ attachments: true })
    pick(shadow, [png('a.png'), png('b.png')])

    await vi.waitFor(() => expect(thumbs(shadow)).toHaveLength(2))
    expect(shadow.root.querySelector('.mtb-chat-thumbs')!.hasAttribute('hidden')).toBe(false)
    expect(shadow.root.querySelector('.mtb-chat-attach-count')!.textContent).toBe('2/5')
    expect(thumbs(shadow)[0].querySelector('img')!.getAttribute('src')).toBe('blob:mock/1')

    const remove = thumbs(shadow)[0].querySelector<HTMLButtonElement>('.mtb-chat-thumb-remove')!
    expect(remove.getAttribute('aria-label')).toBe('Remove a.png')
    remove.click()
    expect(thumbs(shadow)).toHaveLength(1)
    expect(revoked).toEqual(['blob:mock/1'])
    expect(shadow.root.querySelector('.mtb-chat-attach-count')!.textContent).toBe('1/5')

    type(shadow, 'Use this hero instead')
    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-send')!.click()
    await vi.waitFor(() => expect(opts['onSubmit']).toHaveBeenCalledTimes(1))
    const [description, files] = (opts['onSubmit'] as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(description).toBe('Use this hero instead')
    expect((files as File[]).map(f => f.name)).toEqual(['b.png'])

    // Gone after send, like the screenshot toggle, with its preview released.
    expect(shadow.root.querySelector('.mtb-chat-thumbs')).toBeNull()
    expect(shadow.root.querySelector('.mtb-chat-attach')).toBeNull()
    expect(revoked).toEqual(['blob:mock/1', 'blob:mock/2'])
    popup.destroy()
    shadow.destroy()
  })

  it('stops at five and says so', async () => {
    const { shadow, popup } = mountPopup({ attachments: true })
    pick(shadow, ['1', '2', '3', '4', '5', '6'].map(n => png(`${n}.png`)))
    await vi.waitFor(() => expect(thumbs(shadow)).toHaveLength(5))
    expect(errorText(shadow)).toBe('Up to 5 images')
    expect(shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-attach')!.disabled).toBe(true)
    popup.destroy()
    shadow.destroy()
  })

  it('rejects files that are not images', async () => {
    const { shadow, popup } = mountPopup({ attachments: true })
    pick(shadow, [new File(['x'], 'notes.pdf', { type: 'application/pdf' })])
    await vi.waitFor(() => expect(errorText(shadow)).toBe('Only PNG, JPEG, WebP or GIF'))
    expect(thumbs(shadow)).toHaveLength(0)
    popup.destroy()
    shadow.destroy()
  })

  it('reports an image over the size ceiling', async () => {
    const { shadow, popup } = mountPopup({ attachments: true })
    pick(shadow, [new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.gif', { type: 'image/gif' })])
    await vi.waitFor(() => expect(errorText(shadow)).toBe('Each image must be under 10 MB'))
    popup.destroy()
    shadow.destroy()
  })

  it('attaches an image pasted into the text field', async () => {
    const { shadow, popup } = mountPopup({ attachments: true })
    const input = shadow.root.querySelector<HTMLTextAreaElement>('.mtb-chat-input')!
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: { files: [png('clip.png')], types: ['Files'] } })
    input.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(thumbs(shadow)).toHaveLength(1))
    popup.destroy()
    shadow.destroy()
  })

  it('attaches images dropped onto the composer', async () => {
    const { shadow, popup } = mountPopup({ attachments: true })
    const composer = shadow.root.querySelector<HTMLElement>('.mtb-chat-composer')!
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [png('d.png')], types: ['Files'] } })
    composer.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(thumbs(shadow)).toHaveLength(1))
    popup.destroy()
    shadow.destroy()
  })

  it('resends the same files when the first send fails and Retry is pressed', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(makeSession({ ai_clarify_available: false }))
    const { shadow, popup } = mountPopup({ attachments: true, onSubmit })
    pick(shadow, [png('a.png')])
    await vi.waitFor(() => expect(thumbs(shadow)).toHaveLength(1))
    type(shadow, 'Swap it')
    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-send')!.click()
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-error-retry')).toBeTruthy())
    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-error-retry')!.click()
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect((onSubmit.mock.calls[1][1] as File[]).map(f => f.name)).toEqual(['a.png'])
    popup.destroy()
    shadow.destroy()
  })

  it('says the images failed, not the feedback, on an upload failure', () => {
    const { shadow, popup } = mountPopup({ attachments: true })
    const retry = vi.fn()
    popup.showFinalizeFailure(retry, 'uploads')
    expect(shadow.root.querySelector('.mtb-chat-finalize-message')!.textContent).toBe("Couldn't upload your images. Try again.")
    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-finalize-retry')!.click()
    expect(retry).toHaveBeenCalled()
    popup.destroy()
    shadow.destroy()
  })

  it('releases previews on teardown', async () => {
    const { shadow, popup } = mountPopup({ attachments: true })
    pick(shadow, [png('a.png')])
    await vi.waitFor(() => expect(thumbs(shadow)).toHaveLength(1))
    popup.destroy()
    expect(revoked).toEqual(['blob:mock/1'])
    shadow.destroy()
  })
})
