import type { ShadowContainer } from './shadow'
import type { I18nMessages } from '../i18n'

// Surfaces that dock to the bottom edge on a phone — the corner the launcher
// lives in there. While one is up the launcher steps aside (narrow widths
// only, see widget.css): left in place it sits on top of the sheet's own
// buttons. Every chat card, the receipt included, is a `.mtb-chat`.
const BOTTOM_SURFACES = '.mtb-chat, .mtb-frustration-prompt'

// Icons carry the phone form, where a 52px circle has no room for the label.
// The label stays in the DOM for the accessible name and for the desktop tab.
const LAUNCH_ICON =
  '<svg class="mtb-tab-icon-launch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 12a8 8 0 0 1-8 8H8l-4.5 3V12a8 8 0 0 1 8-8h1.5a8 8 0 0 1 8 8z"/>' +
  '<path d="M12.5 9v6M9.5 12h6"/>' +
  '</svg>'
const EXIT_ICON =
  '<svg class="mtb-tab-icon-exit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M6 6l12 12M18 6L6 18"/>' +
  '</svg>'

export class FeedbackTab {
  private el: HTMLButtonElement
  private labelEl: HTMLSpanElement
  private onClick: () => void
  private idleLabel: string
  private activeLabel: string
  private customText?: string
  private active = false
  private surfaces: MutationObserver | null = null

  constructor(
    private shadow: ShadowContainer,
    messages: I18nMessages,
    position: 'left' | 'right',
    onClick: () => void,
    customText?: string,
  ) {
    this.onClick = onClick
    this.customText = customText
    this.el = shadow.el<HTMLButtonElement>('button', 'mtb-tab')
    this.el.type = 'button'
    if (position === 'left') this.el.classList.add('left')
    this.el.innerHTML =
      `<span class="mtb-tab-icon" aria-hidden="true">${LAUNCH_ICON}${EXIT_ICON}</span>` +
      '<span class="mtb-tab-label"></span>'
    this.labelEl = this.el.querySelector<HTMLSpanElement>('.mtb-tab-label')!
    this.idleLabel = customText ?? messages.tab
    this.activeLabel = messages.toolbar.exit
    this.setLabel(this.idleLabel)
    this.el.addEventListener('mousedown', this.preserveHostFocus)
    this.el.addEventListener('click', onClick)
    this.shadow.append(this.el)
    this.watchSurfaces()
  }

  // The cards are mounted and torn down from a dozen places in the controller;
  // watching the shadow root catches all of them, and whatever is added later,
  // without each site having to remember the launcher.
  private watchSurfaces(): void {
    this.syncYield()
    if (typeof MutationObserver === 'undefined') return
    this.surfaces = new MutationObserver(this.syncYield)
    this.surfaces.observe(this.shadow.root, { childList: true })
  }

  private syncYield = (): void => {
    const occupied = this.shadow.root.querySelector(BOTTOM_SURFACES) !== null
    this.el.classList.toggle('mtb-tab--yielding', occupied)
  }

  private preserveHostFocus = (event: MouseEvent): void => {
    event.preventDefault()
  }

  private setLabel(label: string): void {
    this.labelEl.textContent = label
    this.el.setAttribute('aria-label', label)
  }

  setMessages(messages: I18nMessages): void {
    this.idleLabel = this.customText ?? messages.tab
    this.activeLabel = messages.toolbar.exit
    this.setLabel(this.active ? this.activeLabel : this.idleLabel)
  }

  setActive(active: boolean): void {
    this.active = active
    this.el.classList.toggle('active', active)
    this.setLabel(active ? this.activeLabel : this.idleLabel)
  }

  destroy(): void {
    this.surfaces?.disconnect()
    this.surfaces = null
    this.el.removeEventListener('mousedown', this.preserveHostFocus)
    this.el.removeEventListener('click', this.onClick)
    this.el.remove()
  }
}
