#!/usr/bin/env node
// Writes dist/testmate.d.ts: one self-contained declaration file for people who
// vendor the built bundle (e.g. the copy served at
// https://testmate.beansmile.ai/widget/testmate.js) instead of installing the
// package. It inlines dist/types.d.ts and declares the window globals.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist')
const pkg = JSON.parse(readFileSync(join(dist, '..', 'package.json'), 'utf8'))

const types = readFileSync(join(dist, 'types.d.ts'), 'utf8')
  .replace(/\/\/# sourceMappingURL=.*$/m, '')
  .trim()
if (/^import /m.test(types)) {
  throw new Error('bundle-dts: types.d.ts gained imports; inline them here')
}

const index = readFileSync(join(dist, 'index.d.ts'), 'utf8')
const api = index.match(/declare const TestMate: (\{[\s\S]*?\n\});/)
if (!api) throw new Error('bundle-dts: could not find TestMate declaration in index.d.ts')

const out = `// ${pkg.name} ${pkg.version} — TestMate feedback widget.
// Forked from makethisbetter/makethisbetter-js (MIT).

${types}

export interface TestMateApi ${api[1]}

export declare const TestMate: TestMateApi
/** Upstream name, kept for compatibility. */
export declare const MakeThisBetter: TestMateApi

declare global {
  interface Window {
    TestMate: TestMateApi
    /** Upstream name, kept for compatibility. */
    MakeThisBetter: TestMateApi
  }
}
`
writeFileSync(join(dist, 'testmate.d.ts'), out)
console.log('wrote dist/testmate.d.ts')
