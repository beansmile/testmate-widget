import { BLOCK_CLASS, MASK_TEXT_CLASS } from '../privacy/dom'
import { WIDGET_HOST_ID } from '../context/dom-utils'
import { filterInputValue, isSensitiveField } from '../privacy/fields'
import { filterSensitiveText } from '../privacy/sanitize'
import { createSensitiveTextContext, hasSensitiveTextContext } from '../privacy/text-context'

// Privacy masks are applied to html-to-image's clone, not painted onto the
// bitmap afterwards. A cover painted at a rect measured from the live page
// lands on the right pixels only while the clone lays out exactly like the
// live page — and FB-16 showed it does not always: a centered settings column
// rendered flush-left in the clone, so the gray box sat 480px to the right of
// the text it was meant to hide, which was left fully readable. A mask that is
// part of the clone's own tree moves with its content wherever html-to-image
// puts it, and needs none of the viewport-to-clone scroll arithmetic either.
//
// Each kind keeps the clone's layout untouched (no box ever changes size) and
// hides the content inside the box:
//   block — an rr-block element: its own box is painted gray, its text made
//           transparent and every descendant hidden, images included.
//   field — an input/textarea/select: the value is dropped from the clone and
//           the control painted gray.
//   text  — a single text node: wrapped in a span whose background is gray
//           and whose text is transparent. An inline span with no padding or
//           border reflows nothing.
export type MaskKind = 'block' | 'field' | 'text'
export type PrivacyMasks = Map<Node, MaskKind>

export const MASK_COLOR = '#e5e7eb'
// Same halo the painted covers had, drawn as a box-shadow so it takes no space.
const MASK_HALO_PX = 2
// Text inside these never renders as page text, and wrapping it in a span
// would corrupt a style sheet or a select option; the select is handled as a
// field.
const NON_RENDERED_TEXT_PARENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'OPTION', 'TEXTAREA'])
const TRANSPARENT_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

export function collectPrivacyMasks(root: HTMLElement): PrivacyMasks {
  const masks: PrivacyMasks = new Map()
  for (const element of elementsIncludingRoot(root, `.${BLOCK_CLASS}`)) {
    // A block inside a block is covered by the outer one.
    if (element !== root && element.parentElement && isWidgetOrBlocked(element.parentElement)) continue
    masks.set(element, 'block')
  }

  for (const element of root.querySelectorAll('input, textarea, select')) {
    if (isWidgetOrBlocked(element)) continue
    const value = element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement
      ? element.value
      : ''
    const isMasked = element.closest(`.${MASK_TEXT_CLASS}`) !== null
    const hasSensitiveValue = isSensitiveField(element) || filterInputValue(value, element) !== value
    if (!isMasked && !hasSensitiveValue) continue
    masks.set(element, 'field')
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textContext = createSensitiveTextContext()
  let node = walker.nextNode()
  while (node) {
    const parent = node.parentElement
    if (parent && !NON_RENDERED_TEXT_PARENTS.has(parent.tagName) && !isWidgetOrBlocked(parent)) {
      const text = node.textContent ?? ''
      const isMasked = parent.closest(`.${MASK_TEXT_CLASS}`) !== null
      if (isMasked || filterSensitiveText(text) !== text || hasSensitiveTextContext(node, textContext)) {
        masks.set(node, 'text')
      }
    }
    node = walker.nextNode()
  }

  return masks
}

/**
 * html-to-image's onClone hook: `clonedNode` is the finished clone of
 * `nativeNode` — children cloned, computed style inlined — and whatever this
 * returns takes its place in the clone tree.
 */
export function maskClonedNode(masks: PrivacyMasks, nativeNode: Node, clonedNode: Node): Node | undefined {
  const kind = masks.get(nativeNode)
  if (!kind) return undefined
  if (kind === 'text') return maskText(clonedNode)
  if (!(clonedNode instanceof Element)) return undefined
  if (kind === 'field') maskField(clonedNode)
  else maskBlock(clonedNode)
  return clonedNode
}

function maskText(clonedText: Node): Node {
  const span = document.createElement('span')
  span.setAttribute('data-mtb-mask', 'text')
  const style = span.style
  hideText(style)
  style.setProperty('background-color', MASK_COLOR, 'important')
  style.setProperty('box-shadow', `0 0 0 ${MASK_HALO_PX}px ${MASK_COLOR}`, 'important')
  style.setProperty('border-radius', '2px', 'important')
  style.setProperty('text-decoration', 'none', 'important')
  span.appendChild(clonedText)
  return span
}

function maskField(clone: Element): void {
  clone.setAttribute('data-mtb-mask', 'field')
  if (clone instanceof HTMLInputElement) {
    clone.removeAttribute('value')
    clone.value = ''
  } else if (clone instanceof HTMLTextAreaElement) {
    clone.textContent = ''
    clone.value = ''
  }
  clone.removeAttribute('placeholder')
  if (clone instanceof HTMLElement) {
    const style = clone.style
    hideText(style)
    paintGray(style)
    style.setProperty('box-shadow', `0 0 0 ${MASK_HALO_PX}px ${MASK_COLOR}`, 'important')
    style.setProperty('caret-color', 'transparent', 'important')
  }
}

function maskBlock(clone: Element): void {
  clone.setAttribute('data-mtb-mask', 'block')
  if (clone instanceof HTMLElement || clone instanceof SVGElement) {
    hideText(clone.style)
    paintGray(clone.style)
    clone.style.setProperty('box-shadow', 'none', 'important')
  }
  blankImage(clone)
  // html-to-image inlines `visibility: visible` on every element, so each
  // descendant has to be hidden on its own; the element's own background is
  // what paints the box. Images are also blanked so nothing inside the block
  // is fetched and embedded later.
  for (const descendant of Array.from(clone.querySelectorAll('*'))) {
    if (descendant instanceof HTMLElement || descendant instanceof SVGElement) {
      descendant.style.setProperty('visibility', 'hidden', 'important')
      descendant.style.setProperty('background-image', 'none', 'important')
    }
    blankImage(descendant)
  }
}

function hideText(style: CSSStyleDeclaration): void {
  style.setProperty('color', 'transparent', 'important')
  style.setProperty('-webkit-text-fill-color', 'transparent', 'important')
  style.setProperty('text-shadow', 'none', 'important')
}

function paintGray(style: CSSStyleDeclaration): void {
  style.setProperty('background-color', MASK_COLOR, 'important')
  style.setProperty('background-image', 'none', 'important')
  style.setProperty('border-color', MASK_COLOR, 'important')
  style.setProperty('outline', 'none', 'important')
}

function blankImage(element: Element): void {
  if (element instanceof HTMLImageElement) {
    element.setAttribute('src', TRANSPARENT_IMAGE_PLACEHOLDER)
    element.removeAttribute('srcset')
  }
  if (element instanceof HTMLSourceElement) {
    element.removeAttribute('src')
    element.removeAttribute('srcset')
  }
}

function elementsIncludingRoot(root: HTMLElement, selector: string): Element[] {
  const descendants = Array.from(root.querySelectorAll(selector))
  return root.matches(selector) ? [root, ...descendants] : descendants
}

function isWidgetOrBlocked(element: Element): boolean {
  return element.closest(`#${WIDGET_HOST_ID}`) !== null || element.closest(`.${BLOCK_CLASS}`) !== null
}
