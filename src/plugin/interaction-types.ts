import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** Same-process capability, minted only for an exact live claimed input/turn. */
export interface InteractionScope {
  sessionId: string
  inputId: string
  turn: number
  signal: AbortSignal
  current(): boolean
}
export interface ApprovalInteraction extends InteractionScope {
  toolName: string
  reason?: string | undefined
  /** Localized reason supplied by the approval service; prefer it over `reason`. */
  displayReason?: { readonly en: string; readonly [locale: string]: string } | undefined
  callId?: string | undefined
}
export interface QuestionInteraction extends InteractionScope { questions: AskUserQuestionItem[] }
export interface InteractionHandlers {
  approval(request: ApprovalInteraction): Promise<ApprovalOutcome>
  question(request: QuestionInteraction): Promise<AskUserQuestionAnswer>
}
