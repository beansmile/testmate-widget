import type { ShadowContainer } from '../widget/shadow'
import type { I18nMessages } from '../i18n'
import { escapeHtml, isImeConfirmKeydown } from '../context/dom-utils'
import { SheetLayout } from '../popup/sheet'
import { formatMessage } from '../i18n'
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  looksLikeImage,
  prepareAttachment,
} from '../attachments/prepare'
import type { PrepareFailure } from '../attachments/prepare'

const PAPERCLIP_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 7.6l-5.3 5.3a3.4 3.4 0 01-4.8-4.8l5.6-5.6a2.3 2.3 0 013.2 3.2L6.4 11.2a1.1 1.1 0 01-1.6-1.6l5-5"/></svg>'

interface DrawNoteBarOptions {
  messages: I18nMessages
  onUndo: () => void
  onRedo: () => void
  onCancel: () => void
  /** `files` are the reporter's attached images, already downscaled and re-encoded. */
  onSubmit: (note: string, files: File[]) => void
  /**
   * Show a paperclip beside the screenshot disclosure. One row has no room for
   * thumbnails, so picked images show as a count chip that clears them.
   */
  attachments?: boolean
  // Fired on every keystroke; the owner uses it to defer heavy capture work
  // until the reporter pauses.
  onActivity?: () => void
}

export class DrawNoteBar {
  private el: HTMLDivElement
  private sheet: SheetLayout
  private input!: HTMLInputElement
  private undoBtn!: HTMLButtonElement
  private redoBtn!: HTMLButtonElement
  private submitBtn!: HTMLButtonElement
  private onSubmit: (note: string, files: File[]) => void
  private submitLabel: string
  private messages: I18nMessages
  private files: File[] = []
  private preparing = 0
  private loading = false
  private destroyed = false

  constructor(shadow: ShadowContainer, opts: DrawNoteBarOptions) {
    this.onSubmit = opts.onSubmit
    this.submitLabel = opts.messages.draw.submit
    this.messages = opts.messages

    this.el = shadow.el<HTMLDivElement>('div', 'mtb-draw-bar')
    this.el.innerHTML = this.buildHTML(opts.messages, opts.attachments === true)
    shadow.append(this.el)
    // The bar carries a text field and sits flush to the bottom on a phone,
    // which is exactly where the keyboard lands.
    this.sheet = new SheetLayout(this.el)
    this.sheet.apply()

    this.input = this.el.querySelector('.mtb-draw-input')!
    this.undoBtn = this.el.querySelector('.mtb-draw-undo')!
    this.redoBtn = this.el.querySelector('.mtb-draw-redo')!
    this.submitBtn = this.el.querySelector('.mtb-draw-submit')!

    this.undoBtn.addEventListener('click', opts.onUndo)
    this.redoBtn.addEventListener('click', opts.onRedo)
    this.el.querySelector('.mtb-draw-cancel')!.addEventListener('click', opts.onCancel)
    this.submitBtn.addEventListener('click', () => this.submit())
    if (opts.onActivity) this.input.addEventListener('input', opts.onActivity)
    this.input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (isImeConfirmKeydown(e)) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.submit()
      }
    })

    if (opts.attachments) this.bindAttachmentEvents()

    this.input.focus({ preventScroll: true })
  }

  private buildHTML(m: I18nMessages, attachments: boolean): string {
    const attach = attachments
      ? `<button class="mtb-draw-icon-btn mtb-draw-attach" type="button" title="${escapeHtml(m.attachments.add)}" aria-label="${escapeHtml(m.attachments.add)}">${PAPERCLIP_ICON}</button>
      <button class="mtb-draw-attach-count" type="button" hidden></button>
      <input class="mtb-draw-attach-input" type="file" accept="${ACCEPTED_IMAGE_TYPES.join(',')}" multiple hidden tabindex="-1" aria-hidden="true">
      <span class="mtb-draw-attach-error" role="status" aria-live="polite" hidden></span>`
      : ''
    return `
      <input class="mtb-draw-input" type="text" placeholder="${escapeHtml(m.draw.note_placeholder)}" />
      <button class="mtb-draw-icon-btn mtb-draw-undo" type="button" title="${escapeHtml(m.draw.undo)}" aria-label="${escapeHtml(m.draw.undo)}" disabled>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>
      </button>
      <button class="mtb-draw-icon-btn mtb-draw-redo" type="button" title="${escapeHtml(m.draw.redo)}" aria-label="${escapeHtml(m.draw.redo)}" disabled>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h1"/></svg>
      </button>
      <label class="mtb-draw-shot" title="${escapeHtml(m.popup.screenshot_locked_hint)}">
        <input type="checkbox" checked disabled><span>${escapeHtml(m.popup.screenshot_short)}</span>
      </label>
      ${attach}
      <span class="mtb-draw-sep"></span>
      <button class="mtb-draw-cancel" type="button">${escapeHtml(m.draw.cancel)}</button>
      <button class="mtb-draw-submit" type="button">${escapeHtml(m.draw.submit)}</button>
    `
  }

  // ── Reporter-attached images ────────────────────────────────────────────

  private bindAttachmentEvents(): void {
    const button = this.el.querySelector<HTMLButtonElement>('.mtb-draw-attach')!
    const picker = this.el.querySelector<HTMLInputElement>('.mtb-draw-attach-input')!
    button.addEventListener('click', () => picker.click())
    picker.addEventListener('change', () => {
      const files = Array.from(picker.files ?? [])
      // Reset so picking the same file again (after clearing) still fires.
      picker.value = ''
      void this.addAttachments(files)
    })
    // Clearing is all-or-nothing: with no thumbnails there is nothing to point
    // at one image by.
    this.el.querySelector('.mtb-draw-attach-count')!.addEventListener('click', () => {
      this.files = []
      this.showAttachError(null)
      this.syncAttachments()
      button.focus({ preventScroll: true })
    })
    // A pasted screenshot is the commonest way an image arrives on desktop.
    this.input.addEventListener('paste', (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter(file => looksLikeImage(file))
      if (files.length === 0) return
      if (!e.clipboardData?.types.includes('text/plain')) e.preventDefault()
      void this.addAttachments(files)
    })
  }

  private async addAttachments(files: File[]): Promise<void> {
    if (files.length === 0 || this.loading) return
    this.showAttachError(null)
    const room = MAX_ATTACHMENTS - this.files.length - this.preparing
    let failure: PrepareFailure | 'too_many' | null = files.length > room ? 'too_many' : null
    const accepted = files.slice(0, Math.max(0, room))

    this.preparing += accepted.length
    this.syncAttachments()
    for (const file of accepted) {
      let result: Awaited<ReturnType<typeof prepareAttachment>>
      try {
        result = await prepareAttachment(file)
      } catch {
        result = { ok: false, reason: 'unsupported' }
      }
      this.preparing -= 1
      if (this.destroyed) return
      if (result.ok) this.files.push(result.file)
      else failure ??= result.reason
    }
    this.syncAttachments()
    if (failure) this.showAttachError(failure)
  }

  private syncAttachments(): void {
    const button = this.el.querySelector<HTMLButtonElement>('.mtb-draw-attach')
    const chip = this.el.querySelector<HTMLButtonElement>('.mtb-draw-attach-count')
    if (!button || !chip) return
    const count = this.files.length
    button.disabled = this.loading || count + this.preparing >= MAX_ATTACHMENTS
    chip.hidden = count === 0
    chip.disabled = this.loading
    chip.textContent = `${formatMessage(this.messages.attachments.count, { count, max: MAX_ATTACHMENTS })} \u00d7`
    const label = formatMessage(this.messages.attachments.remove, { name: this.files.map(f => f.name).join(', ') })
    chip.setAttribute('aria-label', label)
    chip.title = label
    // An image still being downscaled would otherwise be silently left behind.
    if (!this.loading) this.submitBtn.disabled = this.preparing > 0
  }

  private showAttachError(reason: PrepareFailure | 'too_many' | null): void {
    const el = this.el.querySelector<HTMLSpanElement>('.mtb-draw-attach-error')
    if (!el) return
    const m = this.messages.attachments
    const text = reason === 'too_many'
      ? formatMessage(m.too_many, { max: MAX_ATTACHMENTS })
      : reason === 'too_large'
        ? formatMessage(m.too_large, { max: Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024)) })
        : reason === 'unsupported'
          ? m.unsupported
          : ''
    el.textContent = text
    el.hidden = !text
  }

  setLoading(loading: boolean): void {
    this.loading = loading
    this.syncAttachments()
    if (loading) {
      this.submitBtn.disabled = true
      this.submitBtn.classList.add('mtb-btn-loading')
      this.submitBtn.textContent = this.messages.popup.sending
      this.input.disabled = true
    } else {
      this.submitBtn.disabled = false
      this.submitBtn.classList.remove('mtb-btn-loading')
      this.submitBtn.textContent = this.submitLabel
      this.input.disabled = false
    }
  }

  setUndoRedo(canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo
    this.redoBtn.disabled = !canRedo
  }

  private submit(): void {
    if (this.preparing > 0) return
    this.onSubmit(this.input.value.trim(), [...this.files])
  }

  destroy(): void {
    this.destroyed = true
    this.sheet.release()
    this.el.remove()
  }
}

