import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'

/** A channel prompt can expire while the native desktop request remains open. */
export type ApprovalPromptOutcome = ApprovalOutcome | 'expired'
/** Leave room for every fixed settlement label without truncating tool context. */
export const APPROVAL_STATUS_RESERVE = 64

export function approvalStatus(outcome: ApprovalPromptOutcome): string {
  switch (outcome) {
    case 'allowed-once': return '已批准一次'
    case 'rejected': return '已拒绝'
    case 'expired': return '渠道审批已过期，请在 DSH 桌面处理'
    case 'unavailable': return '渠道审批不可用，请在 DSH 桌面处理'
    case 'cancelled': return '审批已取消'
  }
}
