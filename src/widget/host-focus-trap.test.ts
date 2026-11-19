import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPopup } from '../popup/chat-popup'
import { ShadowContainer } from './shadow'
import { getMessages } from '../i18n'

// FB-20: a host page's modal drawer kept focus to itself, so the composer
// opened on top of it could be clicked but never typed into. These tests stand
// up the two families of trap found in the wild around a modal element and
// check the composer stays usable — and still behaves like itself — inside them.

function mountModal(): { modal: HTMLElement; modalInput: HTMLInputElement } {
  const modal = document.createElement('div')
  modal.setAttribute('role', 'dialog')
  const modalInput = document.createElement('input')
  modal.appendChild(modalInput)
  document.body.appendChild(modal)
  modalInput.focus()
  return { modal, modalInput }
}

/** Radix FocusScope: bubble-phase focusin/focusout on document. */
function installBubbleTrap(modal: HTMLElement, modalInput: HTMLInputElement) {
  const pulledBack = vi.fn()
  const onFocusIn = (event: FocusEvent) => {
    if (modal.contains(event.target as Node)) return
    pulledBack('focusin')
    modalInput.focus()
  }
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null
    if (next === null) return
    if (modal.contains(next)) return
    pulledBack('focusout')
    modalInput.focus()
  }
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
  return {
    pulledBack,
    remove() {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    },
  }
}

/** The focus-trap library: capture-phase focusin and Tab on document. */
function installCaptureTrap(modal: HTMLElement, modalInput: HTMLInputElement) {
  const pulledBack = vi.fn()
  const onFocusIn = (event: FocusEvent) => {
    const target = event.composedPath()[0] as Node
    if (modal.contains(target)) return
    event.stopImmediatePropagation()
    pulledBack('focusin')
    modalInput.focus()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const target = event.composedPath()[0] as Node
    if (modal.contains(target)) return
    event.preventDefault()
    pulledBack('tab')
    modalInput.focus()
  }
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('keydown', onKeydown, true)
  return {
    pulledBack,
    remove() {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('keydown', onKeydown, true)
    },
  }
}

function mountComposer() {
  const shadow = new ShadowContainer()
  const onSubmit = vi.fn().mockReturnValue(new Promise(() => {}))
  const onCancel = vi.fn()
  const popup = new ChatPopup(shadow, {
    targetName: 'Button',
    x: 100,
    y: 100,
    messages: getMessages('zh-CN'),
    onSubmit,
    onCancel,
  } as unknown as ConstructorParameters<typeof ChatPopup>[1])
  const input = shadow.root.querySelector<HTMLTextAreaElement>('.mtb-chat-input')!
  return { shadow, popup, input, onSubmit, onCancel }
}

/** What a real keystroke delivers: composed keydown, then the edit. */
function typeInto(input: HTMLTextAreaElement, text: string): void {
  for (const ch of text) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, composed: true, cancelable: true }))
    input.dispatchEvent(new InputEvent('beforeinput', { data: ch, bubbles: true, composed: true, cancelable: true }))
    input.value += ch
    input.dispatchEvent(new InputEvent('input', { data: ch, bubbles: true, composed: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, composed: true }))
  }
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe.each([
  ['a bubble-phase trap (Radix FocusScope)', installBubbleTrap],
  ['a capture-phase trap (focus-trap)', installCaptureTrap],
] as const)('composer inside %s', (_name, installTrap) => {
  let trap: ReturnType<typeof installTrap>
  let modalInput: HTMLInputElement
  let hostKeys: string[]
  const recordHostKey = (event: Event) => hostKeys.push(`${event.type}:${(event as KeyboardEvent).key ?? ''}`)

  beforeEach(() => {
    const mounted = mountModal()
    modalInput = mounted.modalInput
    trap = installTrap(mounted.modal, modalInput)
    hostKeys = []
    for (const type of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput']) {
      document.addEventListener(type, recordHostKey)
    }
  })

  afterEach(() => {
    trap.remove()
    for (const type of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput']) {
      document.removeEventListener(type, recordHostKey)
    }
    document.body.innerHTML = ''
  })

  it('keeps focus in the textarea it autofocuses and when it is clicked', () => {
    const { shadow, popup, input } = mountComposer()

    expect(shadow.root.activeElement).toBe(input)
    expect(document.activeElement).toBe(shadow.host)

    // Leave for a chip, come back to the field — the reporter's exact path.
    shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-qr')!.click()
    input.blur()
    modalInput.focus()
    input.focus()

    expect(shadow.root.activeElement).toBe(input)
    expect(trap.pulledBack).not.toHaveBeenCalled()

    popup.destroy()
    shadow.destroy()
  })

  it('takes typing without the host page seeing the keys', () => {
    const { shadow, popup, input } = mountComposer()
    const send = shadow.root.querySelector<HTMLButtonElement>('.mtb-chat-send')!

    typeInto(input, 'hi /')

    expect(input.value).toBe('hi /')
    expect(shadow.root.activeElement).toBe(input)
    // The widget's own input listener still ran.
    expect(send.disabled).toBe(false)
    expect(hostKeys).toEqual([])

    popup.destroy()
    shadow.destroy()
  })

  it('still sends on Enter', () => {
    const { shadow, popup, input, onSubmit } = mountComposer()

    typeInto(input, 'broken')
    press(input, 'Enter')

    expect(onSubmit).toHaveBeenCalledWith('broken', expect.anything())

    popup.destroy()
    shadow.destroy()
  })

  it('still closes on Escape typed in the field', () => {
    const { shadow, popup, input, onCancel } = mountComposer()

    const event = press(input, 'Escape')

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(hostKeys).toEqual([])

    popup.destroy()
    shadow.destroy()
  })

  it('cycles Tab within the card instead of letting the page take it', () => {
    const { shadow, popup, input } = mountComposer()
    typeInto(input, 'x')
    const card = shadow.root.querySelector<HTMLElement>('.mtb-chat')!
    const tabbables = Array.from(card.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])'))
      .filter(el => !el.hidden)
    const first = tabbables[0]
    const last = tabbables[tabbables.length - 1]

    last.focus()
    const forward = press(last, 'Tab')
    expect(forward.defaultPrevented).toBe(true)
    expect(shadow.root.activeElement).toBe(first)

    const backward = press(first, 'Tab', { shiftKey: true })
    expect(backward.defaultPrevented).toBe(true)
    expect(shadow.root.activeElement).toBe(last)

    expect(trap.pulledBack).not.toHaveBeenCalled()
    expect(hostKeys).toEqual([])

    popup.destroy()
    shadow.destroy()
  })

  it('hands focus back to the page untouched once the widget is gone', () => {
    const { shadow, popup, input } = mountComposer()
    popup.destroy()
    shadow.destroy()
    expect(input.isConnected).toBe(false)

    // A page element outside the modal: the trap must see this and act.
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    expect(trap.pulledBack).toHaveBeenCalled()
    expect(document.activeElement).toBe(modalInput)
  })
})

describe('ShadowContainer focus isolation', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('still tells the page about focus moving between its own elements', () => {
    const shadow = new ShadowContainer()
    const a = document.createElement('input')
    const b = document.createElement('input')
    document.body.append(a, b)
    const seen: string[] = []
    const record = (e: Event) => seen.push(`${e.type}:${(e.target as HTMLElement) === a ? 'a' : 'b'}`)
    document.addEventListener('focusin', record)
    document.addEventListener('focusout', record)

    a.focus()
    b.focus()

    expect(seen).toEqual(['focusin:a', 'focusout:a', 'focusin:b'])

    document.removeEventListener('focusin', record)
    document.removeEventListener('focusout', record)
    shadow.destroy()
  })

  it('withholds the focusout of a page element whose focus moves into the widget', () => {
    const shadow = new ShadowContainer()
    const field = shadow.el('textarea')
    shadow.append(field)
    const pageInput = document.createElement('input')
    document.body.appendChild(pageInput)
    pageInput.focus()
    const onFocusOut = vi.fn()
    document.addEventListener('focusout', onFocusOut)

    field.focus()

    expect(onFocusOut).not.toHaveBeenCalled()
    document.removeEventListener('focusout', onFocusOut)
    shadow.destroy()
  })
})
