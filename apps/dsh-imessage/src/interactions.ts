import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'
import { PluginError } from './errors.js'
import { parseQuestionAnswer } from './question-answer.js'
import type { SpectrumInboundMessage } from './spectrum-runtime.js'

interface ApprovalPending {
  kind: 'approval'
  id: string
  agent: Agent
  resolve(outcome: ApprovalOutcome): void
  finish(): void
}

interface QuestionPending {
  kind: 'question'
  id: string
  agent: Agent
  questions: AskUserQuestionItem[]
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: Error): void
  finish(): void
}

/** Host callbacks that bind interaction requests to one correlated iMessage turn. */
export interface InteractionOwnership {
  /** Whether the agent's current turn was claimed from this plugin's message id. */
  ownsCurrentTurn(agent: Agent): boolean
  /** The DM channel correlated to that exact owned turn. */
  channelFor(agent: Agent): SpectrumInboundMessage | undefined
  /** Whether delivery is currently healthy enough to claim an interaction. */
  deliveryHealthy(): boolean
}

/** Correlates DSH approvals/questions with direct iMessage response commands. */
export class InteractionBroker {
  private readonly approvals = new Map<string, ApprovalPending>()
  private readonly questions = new Map<string, QuestionPending>()

  /** Construct one fail-closed broker. */
  constructor(
    private readonly ownership: InteractionOwnership,
    private readonly timeoutMs: number,
  ) {}

  /** Whether an agent has any unresolved human interaction. */
  hasPending(agent: Agent): boolean {
    return [...this.approvals.values(), ...this.questions.values()].some(item => item.agent === agent)
  }

  /** Install approval interception and the schema-compatible ask-user shadow. */
  install(agentCtx: Context, hostCtx: Context): () => void {
    const broker = this
    const disposeApproval = agentCtx.on('approval/request', (request, next) => {
      return this.requestApproval(request, next)
    }, { prepend: true })

    const disposeTool = agentCtx.tools.register(defineTool({
      name: 'ask_user_question',
      description: 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
        + 'Send one or more questions, each with a stable id that will be echoed in the answer.',
      parameters: {
        questions: {
          type: 'array',
          required: true,
          description: 'Questions to ask the user before continuing.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
              question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
              header: {
                type: 'string',
                description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
              },
              options: {
                type: 'array',
                description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                    description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                  },
                },
              },
              multi_select: {
                type: 'boolean',
                description: 'Whether the user may select more than one option. Defaults to false.',
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answers: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  selected: { type: 'array', required: true, items: { type: 'string' } },
                  custom: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        const questions: AskUserQuestionItem[] = args.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...(question.header === undefined ? {} : { header: question.header }),
          ...(question.options === undefined ? {} : { options: question.options }),
          ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }),
        }))
        const agent = exec.agent
        const answer = agent !== undefined && broker.ownership.ownsCurrentTurn(agent)
          ? await broker.requestQuestions(agent, questions, exec.signal)
          : await hostCtx.userQuestions.ask({
            questions,
            ...(agent === undefined ? {} : { agent }),
            signal: exec.signal,
          })
        return {
          answers: answer.answers.map(item => ({
            id: item.id,
            selected: [...item.selected],
            ...(item.custom === undefined ? {} : { custom: item.custom }),
          })),
        }
      },
    }))

    return () => {
      disposeTool()
      disposeApproval()
    }
  }

  /** Resolve one pending approval request. */
  approve(id: string): string {
    const pending = this.approvals.get(id)
    if (pending === undefined) throw missingRequest(id)
    pending.resolve('allowed-once')
    pending.finish()
    return `Approved ${id}.`
  }

  /** Reject one pending approval request. */
  deny(id: string): string {
    const pending = this.approvals.get(id)
    if (pending === undefined) throw missingRequest(id)
    pending.resolve('rejected')
    pending.finish()
    return `Denied ${id}.`
  }

  /** Resolve one pending question request from structured text. */
  answer(id: string, text: string): string {
    const pending = this.questions.get(id)
    if (pending === undefined) throw missingRequest(id)
    const answer = parseQuestionAnswer(pending.questions, text)
    pending.resolve(answer)
    pending.finish()
    return `Answered ${id}.`
  }

  /** Treat a bare reply as an answer only when exactly one question is pending. */
  answerBare(text: string): string | undefined {
    if (this.questions.size !== 1) return undefined
    const pending = this.questions.values().next().value as QuestionPending | undefined
    return pending === undefined ? undefined : this.answer(pending.id, text)
  }

  /** Cancel pending interactions for an agent during `/stop` or disposal. */
  cancelAgent(agent: Agent): void {
    for (const pending of [...this.approvals.values()]) {
      if (pending.agent !== agent) continue
      pending.resolve('cancelled')
      pending.finish()
    }
    for (const pending of [...this.questions.values()]) {
      if (pending.agent !== agent) continue
      pending.reject(new Error('The iMessage interaction was cancelled.'))
      pending.finish()
    }
  }

  /** Cancel every pending interaction during plugin teardown. */
  close(): void {
    const agents = new Set<Agent>()
    for (const pending of this.approvals.values()) agents.add(pending.agent)
    for (const pending of this.questions.values()) agents.add(pending.agent)
    for (const agent of agents) this.cancelAgent(agent)
  }

  private async requestApproval(
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (!this.ownership.ownsCurrentTurn(request.agent)) return next()
    const channel = this.ownership.channelFor(request.agent)
    if (!this.ownership.deliveryHealthy() || channel === undefined) return 'unavailable'
    if (request.signal?.aborted === true) return 'cancelled'

    const id = shortId('approval')
    let pending: ApprovalPending | undefined
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const finish = once(() => {
        this.approvals.delete(id)
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
      })
      const abort = () => {
        resolve('cancelled')
        finish()
      }
      const timer = setTimeout(() => {
        resolve('unavailable')
        finish()
      }, this.timeoutMs)
      pending = { kind: 'approval', id, agent: request.agent, resolve, finish }
      this.approvals.set(id, pending)
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted === true) abort()
    })

    const reason = request.reason?.trim()
    const prompt = [
      `Approval required (${id})`,
      `Tool: ${request.toolName}`,
      ...(reason ? [`Reason: ${reason}`] : []),
      `Reply /approve ${id} or /deny ${id}.`,
    ].join('\n')
    void Promise.resolve().then(() => channel.send(prompt)).catch(() => {
      pending?.resolve('unavailable')
      pending?.finish()
    })
    return outcome
  }

  private async requestQuestions(
    agent: Agent,
    questions: AskUserQuestionItem[],
    signal: AbortSignal,
  ): Promise<AskUserQuestionAnswer> {
    const channel = this.ownership.channelFor(agent)
    if (!this.ownership.deliveryHealthy() || channel === undefined) {
      throw new Error('iMessage delivery is unavailable; the question was not redirected.')
    }
    if (signal.aborted) throw new Error('The iMessage question was cancelled.')
    const id = shortId('question')
    let pending: QuestionPending | undefined
    const result = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const finish = once(() => {
        this.questions.delete(id)
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      })
      const abort = () => {
        reject(new Error('The iMessage question was cancelled.'))
        finish()
      }
      const timer = setTimeout(() => {
        reject(new Error('The iMessage question timed out.'))
        finish()
      }, this.timeoutMs)
      pending = { kind: 'question', id, agent, questions, resolve, reject, finish }
      this.questions.set(id, pending)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    void Promise.resolve().then(() => channel.send(formatQuestions(id, questions))).catch(() => {
      pending?.reject(new Error('The iMessage question could not be delivered.'))
      pending?.finish()
    })
    return result
  }
}

function formatQuestions(id: string, questions: AskUserQuestionItem[]): string {
  const lines = [`Question request (${id})`]
  questions.forEach((question, questionIndex) => {
    lines.push(`${questionIndex + 1}. ${question.header ? `${question.header}: ` : ''}${question.question}`)
    question.options?.forEach((option, optionIndex) => {
      lines.push(`   ${optionIndex + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    })
    if (question.multiSelect) lines.push('   Select multiple choices with commas.')
  })
  if (questions.length === 1) {
    lines.push(`Reply /answer ${id} <choice-or-text>, or send a bare reply.`)
  } else {
    lines.push(`Reply /answer ${id} 1:<answer>; 2:<answer> (one entry per question).`)
  }
  return lines.join('\n')
}

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

function missingRequest(id: string): PluginError {
  return new PluginError('request-not-found', `No pending request matches ${id}.`)
}

function once(callback: () => void): () => void {
  let finished = false
  return () => {
    if (finished) return
    finished = true
    callback()
  }
}
