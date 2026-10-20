import { describe, it, expect } from 'vitest'
import { formatMessage, getMessages } from './index'

describe('getMessages', () => {
  it('returns English for "en"', () => {
    const m = getMessages('en')
    expect(m.tab).toBe('Feedback')
  })

  it('returns Chinese for "zh-CN"', () => {
    const m = getMessages('zh-CN')
    expect(m.tab).toBe('反馈')
    expect(m.toolbar.hint).toBe('点击标注，拖动绘制')
    expect(m.toolbar.hintTouch).toBe('用手指圈出问题')
    expect(m.popup.quickOptions.map(option => option.label)).toEqual([
      '出错',
      '建议',
      '疑问',
    ])
  })

  it('falls back to English for unknown locale', () => {
    const m = getMessages('pt')
    expect(m.tab).toBe('Feedback')
  })

  it('returns English for "en-US" by prefix match fallback', () => {
    const m = getMessages('en-US')
    expect(m.tab).toBe('Feedback')
  })

  it('keeps the widget design quick-option set in every locale', () => {
    for (const locale of ['en', 'zh-CN', 'ja', 'ko', 'es', 'fr', 'de']) {
      expect(getMessages(locale).popup.quickOptions).toHaveLength(3)
    }

    expect(getMessages('en').popup.quickOptions.map(option => option.label)).toEqual([
      'Broken',
      'Suggestion',
      'Confused',
    ])
  })
})

describe('attachments strings', () => {
  const locales = ['en', 'zh-CN', 'ja', 'ko', 'es', 'fr', 'de']

  it('has every key in every locale with the placeholders the composer fills', () => {
    const keys = Object.keys(getMessages('en').attachments).sort()
    for (const locale of locales) {
      const m = getMessages(locale).attachments
      expect(Object.keys(m).sort(), locale).toEqual(keys)
      expect(m.count, locale).toContain('{count}')
      expect(m.count, locale).toContain('{max}')
      expect(m.too_many, locale).toContain('{max}')
      expect(m.too_large, locale).toContain('{max}')
      expect(m.remove, locale).toContain('{name}')
    }
  })

  it('formats placeholders', () => {
    expect(formatMessage(getMessages('en').attachments.too_many, { max: 5 })).toBe('Up to 5 images')
    expect(formatMessage('{count}/{max} {other}', { count: 2, max: 5 })).toBe('2/5 {other}')
  })
})
