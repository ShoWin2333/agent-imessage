/**
 * Binding rules shared by the Host validator and the settings panel.
 *
 * This module is intentionally free of Node.js and zod imports so the browser
 * artifact can enforce the same semantic rules without shipping a second copy of
 * the schema. Structure is still enforced by the Host Config schema; this module
 * owns cross-field meaning and returns stable codes for localization.
 */
import { absoluteWorkspacePattern } from '../plugin/workspace-path.js'

export const MAX_BINDINGS = 32
export const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,64}$/
export const CREDENTIAL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const PHONE_RE = /^\+[1-9]\d{6,14}$/
export const TELEGRAM_ID_RE = /^[1-9]\d{0,15}$/
export const ORIGIN_RE = /^https?:\/\/[^\s]+$/

export type ChannelKind = 'imessage' | 'telegram' | 'weixin' | 'qqbot'
export const isChannelKind=(kind:unknown):kind is ChannelKind=>kind==='imessage'||kind==='telegram'||kind==='weixin'||kind==='qqbot'

export interface RuleChannel {
  readonly id: string
  readonly kind: ChannelKind
  readonly projectId?: string | undefined
  readonly senderPhoneNumber?: string | undefined
  readonly assignedPhoneNumber?: string | undefined
  readonly appId?: string | undefined
  readonly botId?: string | undefined
  readonly ownerUserId?: string | undefined
  readonly accountId?: string | undefined
}

export interface RuleBinding {
  readonly id: string
  readonly cwd: string
  readonly credentialRef: string
  readonly permissionPreset: string
  readonly channel: RuleChannel
  readonly weixin?: { readonly ownerUserId: string; readonly baseUrl: string } | undefined
}

export type BindingIssueCode =
  | 'too-many'
  | 'id-format'
  | 'id-duplicate'
  | 'channel-id'
  | 'channel-kind'
  | 'cwd-absolute'
  | 'credential-ref'
  | 'permission-preset'
  | 'channel-field'
  | 'channel-format'
  | 'weixin-owner'
  | 'weixin-origin'
  | 'account-duplicate'

export interface BindingIssue {
  readonly code: BindingIssueCode
  readonly bindingId?: string
  readonly field?: string
}

const requiredFields: Record<ChannelKind, readonly string[]> = {
  imessage: ['projectId', 'senderPhoneNumber', 'assignedPhoneNumber'],
  telegram: ['botId', 'ownerUserId'],
  weixin: ['accountId'],
  qqbot: ['appId', 'ownerUserId'],
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const consumerOf = (channel: RuleChannel): string => {
  const identity = channel.kind === 'imessage' ? channel.projectId
    : channel.kind === 'weixin' ? channel.accountId : channel.kind === 'qqbot' ? channel.appId : channel.botId
  return JSON.stringify([channel.kind, identity])
}

/** Return every semantic problem, in stable field order, for one draft or saved config. */
export function bindingIssues(bindings: readonly RuleBinding[]): BindingIssue[] {
  const issues: BindingIssue[] = []
  if (bindings.length > MAX_BINDINGS) issues.push({ code: 'too-many' })
  const ids = new Set<string>()
  const consumers = new Set<string>()

  for (const binding of bindings) {
    const id = binding.id
    if (!IDENTIFIER_RE.test(id)) issues.push({ code: 'id-format', bindingId: id })
    else if (ids.has(id)) issues.push({ code: 'id-duplicate', bindingId: id })
    ids.add(id)

    if (!absoluteWorkspacePattern.test(binding.cwd)) issues.push({ code: 'cwd-absolute', bindingId: id })
    if (!CREDENTIAL_RE.test(binding.credentialRef)) issues.push({ code: 'credential-ref', bindingId: id })
    if (!text(binding.permissionPreset)) issues.push({ code: 'permission-preset', bindingId: id })

    const channel = binding.channel
    if(!isChannelKind(channel.kind)){issues.push({code:'channel-kind',bindingId:id});continue}
    if (!text(channel.id) || !IDENTIFIER_RE.test(channel.id)) issues.push({ code: 'channel-id', bindingId: id })

    for (const field of requiredFields[channel.kind] ?? []) {
      if (!text(channel[field as keyof RuleChannel])) issues.push({ code: 'channel-field', bindingId: id, field })
    }

    if (channel.kind === 'imessage') {
      for (const field of ['senderPhoneNumber', 'assignedPhoneNumber'] as const) {
        const value = channel[field]
        if (text(value) && !PHONE_RE.test(value)) issues.push({ code: 'channel-format', bindingId: id, field })
      }
    }
    if (channel.kind === 'telegram') {
      for (const field of ['botId', 'ownerUserId'] as const) {
        const value = channel[field]
        if (text(value) && !TELEGRAM_ID_RE.test(value)) issues.push({ code: 'channel-format', bindingId: id, field })
      }
    }
    if (channel.kind === 'qqbot') {
      if (!/^[1-9]\d{3,31}$/.test(channel.appId ?? '') || !/^[A-Za-z0-9_-]{8,128}$/.test(channel.ownerUserId ?? '')) issues.push({code:'channel-format',bindingId:id})
    }
    if (channel.kind === 'weixin') {
      if (text(channel.accountId) && channel.accountId.length > 256) issues.push({ code: 'channel-format', bindingId: id, field: 'accountId' })
      if (!binding.weixin || !text(binding.weixin.ownerUserId)) issues.push({ code: 'weixin-owner', bindingId: id })
      else if (!ORIGIN_RE.test(binding.weixin.baseUrl)) issues.push({ code: 'weixin-origin', bindingId: id })
    }

    const consumer = consumerOf(channel)
    if (consumers.has(consumer)) issues.push({ code: 'account-duplicate', bindingId: id })
    consumers.add(consumer)
  }

  return issues
}
