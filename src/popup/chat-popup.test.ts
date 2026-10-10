import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('auto-closes a finalized receipt after three seconds', async () => {
    vi.useFakeTimers()
    const onClarify = vi.fn().mockResolvedValue(makeResult({ done: true, messages: [] }))
    const { shadow, popup } = mountPopup({
      onClarify,
      resolveEmailCapture: () => ({ onSubmit: vi.fn().mockResolvedValue(true) }),
    })

    popup.submit('clear feedback')
    await vi.waitFor(() => expect(shadow.root.querySelector('.mtb-chat-success')).toBeTruthy())
    await Promise.resolve()
    await Promise.resolve()

    popup.showFinalizeSuccess()
    expect(shadow.root.querySelector('.mtb-chat-email-input')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(2_999)
    expect(shadow.root.querySelector('.mtb-chat')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(1)
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
    expect(opts['onSubmit']).toHaveBeenCalledWith("Something's broken: The save button does nothing")
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
    await vi.waitFor(() => expect(opts['onSubmit']).toHaveBeenCalledWith("I'm confused"))
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
