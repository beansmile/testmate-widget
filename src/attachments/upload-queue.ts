import { UploadRejectedError } from '../api/client'
import type { ApiClient } from '../api/client'

type ItemStatus = 'pending' | 'uploading' | 'done' | 'failed' | 'rejected' | 'skipped'

interface QueueItem {
  file: Blob
  status: ItemStatus
  error?: unknown
}

/**
 * Uploads the reporter's own images into an open submission session, one at a
 * time, and keeps score so finalize can tell "all there" from "something is
 * missing".
 *
 * Two kinds of failure, kept apart on purpose: a network error or 5xx (already
 * retried once by the client) is worth another try when the reporter presses
 * Retry; a typed rejection (too large, unsupported, too many, session gone)
 * will fail identically every time, so the retry gives up on that file and
 * lets the feedback through rather than trapping the reporter in a loop.
 */
export class UploadQueue {
  private items: QueueItem[]
  private controller = new AbortController()
  private running: Promise<void> | null = null

  constructor(
    private api: Pick<ApiClient, 'uploadImage'>,
    private session: { id: string; token: string },
    files: readonly Blob[],
  ) {
    this.items = files.map(file => ({ file, status: 'pending' }))
  }

  start(): void {
    if (this.running) return
    const run = this.drain()
    this.running = run
    void run.finally(() => {
      if (this.running === run) this.running = null
    })
  }

  /** Resolves once nothing is in flight: true when every file made it up. */
  async settled(): Promise<boolean> {
    if (this.running) await this.running
    return !this.items.some(item => item.status === 'failed' || item.status === 'rejected')
  }

  /** Give transient failures another go; stop insisting on permanent ones. */
  retryFailed(): void {
    for (const item of this.items) {
      if (item.status === 'failed') item.status = 'pending'
      else if (item.status === 'rejected') item.status = 'skipped'
    }
    this.start()
  }

  abort(): void {
    this.controller.abort()
  }

  private async drain(): Promise<void> {
    for (const item of this.items) {
      if (this.controller.signal.aborted) return
      if (item.status !== 'pending') continue
      item.status = 'uploading'
      try {
        await this.api.uploadImage(this.session.id, this.session.token, item.file, this.controller.signal)
        item.status = 'done'
      } catch (error) {
        item.error = error
        item.status = error instanceof UploadRejectedError ? 'rejected' : 'failed'
      }
    }
  }
}
