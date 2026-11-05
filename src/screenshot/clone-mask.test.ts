import { afterEach, describe, expect, it } from 'vitest'
import { collectPrivacyMasks, maskClonedNode } from './clone-mask'

describe('collectPrivacyMasks', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('marks rr-block elements, sensitive fields and secret text with their kind', () => {
    document.body.innerHTML = [
      '<section class="rr-block"><p>hidden</p></section>',
      '<input type="password" value="hunter2">',
      '<input name="notes" value="export is slow">',
      '<p>Key ghp_abcdefghijklmnopqrstuvwxyz1234567890</p>',
      '<p>Order 1234 is delayed</p>',
    ].join('')

    const masks = collectPrivacyMasks(document.body)

    expect(masks.get(document.querySelector('section')!)).toBe('block')
    expect(masks.get(document.querySelector('input[type="password"]')!)).toBe('field')
    expect(masks.has(document.querySelector('input[name="notes"]')!)).toBe(false)
    const [, secret, ordinary] = Array.from(document.querySelectorAll('p'))
    expect(secret.textContent).toContain('ghp_')
    expect(masks.get(secret.firstChild!)).toBe('text')
    expect(masks.has(ordinary.firstChild!)).toBe(false)
  })

  it('masks every text node and control inside rr-mask', () => {
    document.body.innerHTML = '<div class="rr-mask">Name <b>Ada</b><input value="plain"></div>'

    const masks = collectPrivacyMasks(document.body)

    expect(masks.get(document.querySelector('.rr-mask')!.firstChild!)).toBe('text')
    expect(masks.get(document.querySelector('b')!.firstChild!)).toBe('text')
    expect(masks.get(document.querySelector('input')!)).toBe('field')
    expect(masks.has(document.querySelector('.rr-mask')!)).toBe(false)
  })

  it('leaves what sits inside an rr-block to the block and skips nested blocks', () => {
    document.body.innerHTML = '<section class="rr-block"><div class="rr-block">x</div><input type="password" value="a">sk-proj-abcdefghijklmnopqrstuvwxyz123456</section>'

    const masks = collectPrivacyMasks(document.body)

    expect(Array.from(masks.entries())).toEqual([[document.querySelector('section')!, 'block']])
  })

  it('never wraps text that is not rendered as page text', () => {
    document.body.innerHTML = [
      '<style>.a{background:url(https://cdn.example.com/a.png?v=1)}</style>',
      '<script type="text/plain">token=sk-proj-abcdefghijklmnopqrstuvwxyz123456</script>',
      '<select><option value="4242424242424242">4242 4242 4242 4242</option></select>',
    ].join('')

    const masks = collectPrivacyMasks(document.body)

    expect(masks.has(document.querySelector('style')!.firstChild!)).toBe(false)
    expect(masks.has(document.querySelector('script')!.firstChild!)).toBe(false)
    expect(masks.has(document.querySelector('option')!.firstChild!)).toBe(false)
    expect(masks.get(document.querySelector('select')!)).toBe('field')
  })

  it('treats the root itself as a block when it is marked', () => {
    document.body.innerHTML = '<section class="rr-block">x</section>'
    const section = document.querySelector<HTMLElement>('section')!

    expect(collectPrivacyMasks(section).get(section)).toBe('block')
  })
})

describe('maskClonedNode', () => {
  it('returns nothing for a node that is not masked', () => {
    const native = document.createElement('p')
    expect(maskClonedNode(new Map(), native, native.cloneNode())).toBeUndefined()
  })

  it('wraps a masked text clone in a span that hides the glyphs over a gray box', () => {
    const native = document.createTextNode('secret')
    const clone = native.cloneNode()

    const result = maskClonedNode(new Map([[native, 'text']]), native, clone) as HTMLElement

    expect(result.tagName).toBe('SPAN')
    expect(result.firstChild).toBe(clone)
    expect(result.style.getPropertyValue('color')).toBe('transparent')
    expect(result.style.getPropertyPriority('color')).toBe('important')
    expect(result.style.getPropertyValue('background-color')).toMatch(/^(#e5e7eb|rgb\(229, 231, 235\))$/i)
    expect(result.style.getPropertyValue('box-shadow')).toContain('2px')
  })

  it('empties a masked field clone and paints it gray', () => {
    const native = document.createElement('textarea')
    native.value = 'hunter2'
    const clone = native.cloneNode() as HTMLTextAreaElement
    clone.innerHTML = native.value
    clone.setAttribute('placeholder', 'Password')

    const result = maskClonedNode(new Map([[native, 'field']]), native, clone) as HTMLTextAreaElement

    expect(result).toBe(clone)
    expect(result.value).toBe('')
    expect(result.textContent).toBe('')
    expect(result.hasAttribute('placeholder')).toBe(false)
    expect(result.getAttribute('data-mtb-mask')).toBe('field')
    expect(result.style.getPropertyValue('background-color')).toMatch(/^(#e5e7eb|rgb\(229, 231, 235\))$/i)
  })

  it('hides everything inside a masked block clone, images included, without touching its box', () => {
    const native = document.createElement('section')
    native.innerHTML = '<p>secret <img src="https://cdn.example.com/a.png" srcset="https://cdn.example.com/a@2x.png 2x"></p>'
    const clone = native.cloneNode(true) as HTMLElement
    clone.style.width = '320px'
    clone.style.height = '180px'

    const result = maskClonedNode(new Map([[native, 'block']]), native, clone) as HTMLElement

    expect(result).toBe(clone)
    expect(result.style.width).toBe('320px')
    expect(result.style.height).toBe('180px')
    expect(result.style.getPropertyValue('background-color')).toMatch(/^(#e5e7eb|rgb\(229, 231, 235\))$/i)
    expect(result.querySelector('p')!.style.getPropertyValue('visibility')).toBe('hidden')
    const img = result.querySelector('img')!
    expect(img.style.getPropertyValue('visibility')).toBe('hidden')
    expect(img.getAttribute('src')).toMatch(/^data:image\/gif;base64,/)
    expect(img.hasAttribute('srcset')).toBe(false)
    expect(result.textContent).toContain('secret')
  })
})
