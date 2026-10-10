#!/usr/bin/env node
// Copies the @rrweb/record UMD build to dist/rrweb-record.js so it can be
// served next to the widget (https://testmate.beansmile.ai/widget/rrweb-record.js,
// the default `recorderUrl`). Refuses to copy anything that is not
// byte-identical to the pinned jsDelivr file the upstream SRI hash covers.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules/@rrweb/record/umd/record.min.js')
const sessionTs = readFileSync(join(root, 'src/record/session.ts'), 'utf8')
const pinned = sessionTs.match(/const RRWEB_SRI = '(sha384-[^']+)'/)?.[1]
if (!pinned) throw new Error('copy-recorder: RRWEB_SRI not found in src/record/session.ts')

const bytes = readFileSync(source)
const actual = 'sha384-' + createHash('sha384').update(bytes).digest('base64')
if (actual !== pinned) {
  throw new Error(`copy-recorder: ${source} hashes to ${actual}, expected ${pinned} (installed @rrweb/record is not 2.1.0?)`)
}
writeFileSync(join(root, 'dist/rrweb-record.js'), bytes)
console.log(`wrote dist/rrweb-record.js (${actual})`)
