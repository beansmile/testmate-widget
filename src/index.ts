import { WidgetController } from './widget/controller'
import { WIDGET_HOST_ID } from './context/dom-utils'
import type { TestMateConfig, MakeThisBetterConfig } from './types'

let instance: WidgetController | null = null
let lastConfig: TestMateConfig | null = null
// A mount deferred until DOMContentLoaded. Held so a second init() — or a
// destroy() — can call it off: otherwise each init before the document is ready
// queues its own listener, and every controller but the last mounts with no
// live reference, leaking its document listeners and detectors for good.
let pendingMount: (() => void) | null = null

function cancelPendingMount(): void {
  if (!pendingMount) return
  document.removeEventListener('DOMContentLoaded', pendingMount)
  pendingMount = null
}

function replaceInstance(config?: TestMateConfig): void {
  cancelPendingMount()
  instance?.destroy()
  instance = config ? new WidgetController(config) : null
}

const TestMate = {
  init(config: TestMateConfig): void {
    // SSR frameworks run the same component code on the server, where there is
    // no document at all — a widget cannot exist there, and throwing a
    // ReferenceError into the host's render pass is the one thing a
    // third-party SDK must never do.
    if (typeof document === 'undefined') return
    replaceInstance()
    lastConfig = config
    if (document.readyState === 'loading') {
      pendingMount = () => {
        pendingMount = null
        replaceInstance(config)
      }
      document.addEventListener('DOMContentLoaded', pendingMount, { once: true })
    } else {
      replaceInstance(config)
    }
  },

  destroy(): void {
    replaceInstance()
    lastConfig = null
  },

  setLocale(locale: string): void {
    if (lastConfig) lastConfig.locale = locale
    instance?.setLocale(locale)
  },

  /**
   * Opens annotation mode from the host's own UI. Pair with
   * `entryMode: 'api'` to replace the built-in launcher entirely (the docked
   * tab, or the floating button phones get) with an entry point of your own.
   */
  open(): void {
    instance?.open()
  },

  close(): void {
    instance?.close()
  },

  /**
   * Shows the launcher again after hideLauncher(): the docked tab, or on
   * screens up to 480px wide the floating button in the bottom corner.
   */
  showLauncher(): void {
    instance?.showLauncher()
  },

  hideLauncher(): void {
    instance?.hideLauncher()
  },
}

// Upstream name, kept so pages and code written against makethisbetter-js keep
// working against the TestMate build unchanged.
const MakeThisBetter = TestMate

export { TestMate, MakeThisBetter }
export type { TestMateConfig, MakeThisBetterConfig }

type TestMateGlobals = { TestMate?: typeof TestMate; MakeThisBetter?: typeof TestMate }

if (typeof window !== 'undefined') {
  const win = window as Window & TestMateGlobals
  win.TestMate = TestMate
  win.MakeThisBetter = TestMate

  document.addEventListener('turbo:load', () => {
    const host = document.getElementById(WIDGET_HOST_ID)
    if (lastConfig && (!host || !host.shadowRoot)) {
      host?.remove()
      replaceInstance(lastConfig)
    }
  })
}
