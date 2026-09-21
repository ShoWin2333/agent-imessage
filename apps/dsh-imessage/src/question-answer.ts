import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'
import { PluginError } from './errors.js'

/** Parse the documented question-answer syntax into DSH's official answer schema. */
export function parseQuestionAnswer(
  questions: AskUserQuestionItem[],
  input: string,
): AskUserQuestionAnswer {
  const value = input.trim()
  if (value.length === 0) throw new PluginError('invalid-command', 'An answer cannot be empty.')
  if (questions.length === 1) {
    const question = questions[0]
    if (question === undefined) return { answers: [] }
    return { answers: [answerQuestion(question, value)] }
  }

  const values = new Map<number, string>()
  for (const part of value.split(';')) {
    const match = /^\s*(\d+)\s*:\s*(.+?)\s*$/u.exec(part)
    if (!match) {
      throw new PluginError('invalid-command', 'For multiple questions, use 1:<answer>; 2:<answer>.')
    }
    const index = Number(match[1])
    const answer = match[2]
    if (!Number.isSafeInteger(index) || index < 1 || index > questions.length || answer === undefined) {
      throw new PluginError('invalid-command', 'A question number is out of range.')
    }
    values.set(index - 1, answer)
  }
  if (values.size !== questions.length) {
    throw new PluginError('invalid-command', 'Answer every numbered question in the request.')
  }
  return {
    answers: questions.map((question, index) => answerQuestion(question, values.get(index) ?? '')),
  }
}

function answerQuestion(question: AskUserQuestionItem, value: string) {
  const options = question.options ?? []
  if (options.length === 0) return { id: question.id, selected: [], custom: value }

  const tokens = value.split(',').map(item => item.trim()).filter(Boolean)
  if (!question.multiSelect && tokens.length !== 1) {
    throw new PluginError('invalid-command', 'Choose exactly one option for this question.')
  }
  const selected: string[] = []
  const custom: string[] = []
  for (const token of tokens) {
    const numeric = /^\d+$/u.test(token) ? Number(token) : undefined
    const option = numeric === undefined
      ? options.find(candidate => candidate.label.toLocaleLowerCase() === token.toLocaleLowerCase())
      : options[numeric - 1]
    if (option === undefined) custom.push(token)
    else selected.push(option.label)
  }
  if (!question.multiSelect && selected.length + custom.length !== 1) {
    throw new PluginError('invalid-command', 'Choose one listed option or enter one custom answer.')
  }
  return {
    id: question.id,
    selected,
    ...(custom.length === 0 ? {} : { custom: custom.join(', ') }),
  }
}
