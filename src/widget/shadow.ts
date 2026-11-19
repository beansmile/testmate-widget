import cssText from '../styles/widget.css?inline'
import { WIDGET_HOST_ID } from '../context/dom-utils'
import type { TestMateConfig } from '../types'
import type { WidgetBrandColors } from './brand-colors'

export class ShadowContainer {
  // Click-away layers listen at different points in a mouse or touch sequence.
  // Keep discrete widget interactions private, but leave pointermove composed
  // because toolbar dragging intentionally tracks movement on document.
  private static readonly HOST_INTERACTION_EVENTS = [
    'pointerdown',
    'pointerup',
    'pointercancel',
    'mousedown',
    'mouseup',
    'touchstart',
    'touchend',
    'touchcancel',
    'click',
    // Typing in a widget field is not the page's business either. A host's
    // bubble-phase hotkeys ("/" to search, single-letter shortcuts, a modal's
    // Tab or Escape handler on document) would otherwise act on keys the
    // reporter meant for the composer. The widget's own document and window
    // key listeners all run in the capture phase (Escape, scroll lock) or sit
    // on its elements or this root, so stopping here costs them nothing.
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
  ] as const

  // A modal on the host page — a Radix/shadcn Dialog or Sheet, a focus-trap
  // drawer, a MUI Modal — keeps focus inside itself by listening for focus
  // changes on document and pulling focus back whenever it lands outside. The
  // widget lives in its own host appended to <body>, outside any such modal,
  // so the moment a composer field takes focus the trap snatches it back and
  // the field cannot be typed into. Stopping at the shadow root cannot help:
  // focus-trap listens on document in the capture phase, which runs before
  // the event ever reaches the root. Window capture runs before document
  // capture, so that is where the page is told nothing. Focus itself still
  // moves; only the notification is withheld.
  //
  // Nothing in the widget listens for focusin or focusout (its elements use
  // focus and blur, which are separate events), so withholding these from the
  // whole path costs the widget nothing.
  private static readonly HOST_FOCUS_EVENTS = ['focusin', 'focusout'] as const

  // Readable so a component can mark the host with its own presence and have
  // :host(...) rules react — the only way CSS inside the shadow tree can be
  // told which components are currently mounted.
  readonly host: HTMLElement
  readonly root: ShadowRoot
  // Only a host we made is ours to take away. One the page supplied has to
  // outlive us, or a framework counting on it being there — Turbo pairs its
  // permanent elements by id — would find it gone after the first teardown.
  private readonly ownsHost: boolean
  // A borrowed host's inline style and theme attribute belong to the page.
  // Snapshot the whole attribute values, not just the properties we write:
  // cssText assignment below replaces everything the customer had inline, so
  // only the full original string can put it back. null means the attribute
  // did not exist, and restoring must remove it rather than leave ''.
  private readonly originalInlineStyle: string | null
  private readonly originalTheme: string | null

  constructor(
    theme: TestMateConfig['theme'] = 'auto',
    brandColors?: WidgetBrandColors,
  ) {
    // A page that renders its own host controls where the widget lives, and
    // that is the only way to survive a framework which replaces <body>
    // wholesale on navigation: Turbo carries an element marked
    // data-turbo-permanent across the swap, shadow root and all, so a
    // recording in progress is not thrown away by a link click.
    const provided = document.getElementById(WIDGET_HOST_ID)
    this.ownsHost = !provided

    this.host = provided ?? document.createElement('div')
    // Attach before any host mutation: a supplied element that cannot take a
    // shadow root fails right here, while the page's element is still exactly
    // as the page left it — there is no partially-styled host to unwind.
    this.root = this.host.shadowRoot ?? this.host.attachShadow({ mode: 'open' })
    this.root.replaceChildren()
    this.originalInlineStyle = this.host.getAttribute('style')
    this.originalTheme = this.host.getAttribute('data-mtb-theme')
    this.host.id = WIDGET_HOST_ID
    this.host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483646;'
    if (brandColors) {
      const rgb = [1, 3, 5].map((offset) => parseInt(brandColors.primary.slice(offset, offset + 2), 16))
      const onPrimaryRgb = [1, 3, 5].map((offset) => parseInt(brandColors.onPrimary.slice(offset, offset + 2), 16))
      this.host.style.setProperty('--mtb-brand-primary', brandColors.primary.toLowerCase())
      this.host.style.setProperty('--mtb-brand-hover', brandColors.hover.toLowerCase())
      this.host.style.setProperty('--mtb-brand-active', brandColors.active.toLowerCase())
      this.host.style.setProperty('--mtb-brand-on-primary', brandColors.onPrimary.toLowerCase())
      this.host.style.setProperty('--mtb-brand-rgb', rgb.join(', '))
      this.host.style.setProperty('--mtb-brand-on-primary-rgb', onPrimaryRgb.join(', '))
      this.host.style.setProperty('--mtb-brand-emphasis', brandColors.primary.toLowerCase())
      this.host.style.setProperty('--mtb-brand-emphasis-rgb', rgb.join(', '))
      this.host.style.setProperty('--mtb-brand-gradient-start', brandColors.primary.toLowerCase())
      this.host.style.setProperty('--mtb-brand-gradient-end', brandColors.hover.toLowerCase())
    }
    this.host.setAttribute('data-mtb-theme', theme)
    if (this.ownsHost) document.body.appendChild(this.host)

    for (const eventType of ShadowContainer.HOST_INTERACTION_EVENTS) {
      this.root.addEventListener(eventType, this.stopHostInteraction)
    }
    for (const eventType of ShadowContainer.HOST_FOCUS_EVENTS) {
      window.addEventListener(eventType, this.hideFocusFromHost, true)
    }

    const style = document.createElement('style')
    style.textContent = cssText
    this.root.appendChild(style)
  }

  el<T extends HTMLElement = HTMLElement>(tag: string, className?: string): T {
    const el = document.createElement(tag) as T
    if (className) el.className = className
    return el
  }

  append(...nodes: Node[]): void {
    for (const n of nodes) this.root.appendChild(n)
  }

  remove(...nodes: Node[]): void {
    for (const n of nodes) {
      if (n.parentNode === this.root) this.root.removeChild(n)
    }
  }

  private stopHostInteraction = (event: Event): void => {
    event.stopPropagation()
  }

  /**
   * Whether a focus change is the widget's own: focus is entering or leaving
   * one of its fields (the host is on the event's path), or focus is leaving a
   * page element *for* the widget. The latter is the focusout a trap such as
   * Radix FocusScope inspects: its relatedTarget, retargeted out of the shadow
   * tree, is the widget host, which the trap reads as "focus escaped".
   */
  private isWidgetFocusEvent(event: FocusEvent): boolean {
    if (event.composedPath().includes(this.host)) return true
    if (event.type !== 'focusout') return false
    const next = event.relatedTarget
    return next instanceof Node && (next === this.host || this.host.contains(next))
  }

  private hideFocusFromHost = (event: Event): void => {
    if (!(event instanceof FocusEvent) || !this.isWidgetFocusEvent(event)) return
    event.stopImmediatePropagation()
  }

  destroy(): void {
    for (const eventType of ShadowContainer.HOST_INTERACTION_EVENTS) {
      this.root.removeEventListener(eventType, this.stopHostInteraction)
    }
    for (const eventType of ShadowContainer.HOST_FOCUS_EVENTS) {
      window.removeEventListener(eventType, this.hideFocusFromHost, true)
    }

    if (!this.ownsHost) {
      // Borrowed. Empty it and leave it standing for whoever put it there.
      this.root.replaceChildren()
      this.host.removeAttribute('data-mtb-toolbar')
      if (this.originalInlineStyle === null) this.host.removeAttribute('style')
      else this.host.setAttribute('style', this.originalInlineStyle)
      if (this.originalTheme === null) this.host.removeAttribute('data-mtb-theme')
      else this.host.setAttribute('data-mtb-theme', this.originalTheme)
      return
    }

    // host.remove() is a safe no-op if the host is already detached — e.g.
    // when Turbo swapped document.body on navigation. removeChild(host) would
    // throw NotFoundError there, aborting re-init and dropping the widget.
    this.host.remove()
  }
}
