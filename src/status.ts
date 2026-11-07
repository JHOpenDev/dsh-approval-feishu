/**
 * Best-effort status file for self-diagnosis: the host's own logs are not user-visible on every
 * platform, so the plugin mirrors its state to `~/.dsh/dsh-approval-feishu.status.json` and the
 * setup guide (`bin/setup.mjs --status`) reads it back.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface ApprovalFeishuStatus {
  state: 'passive' | 'active'
  reason?: string
  receiveId?: string
  receiveIdType?: string
  consumer?: 'running' | 'restarting'
  lastConsumerError?: string
  pendingApprovals?: number
  updatedAt: string
}

/** Absolute path of the status file. */
export const statusFilePath = (): string => join(homedir(), '.dsh', 'dsh-approval-feishu.status.json')

/** Masks an identifier for display: `ou_abc…wxyz`. */
export const maskId = (id: string): string =>
  id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`

/** Merges one patch into the status file; failures are silently ignored (status is best-effort). */
export function writeStatus(patch: Omit<ApprovalFeishuStatus, 'updatedAt'> & { updatedAt?: string }): void {
  try {
    const path = statusFilePath()
    mkdirSync(dirname(path), { recursive: true })
    const next = { ...patch, updatedAt: new Date().toISOString() }
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n')
  } catch { /* a status mirror must never take the plugin down */ }
}
