/** Parsed slash command. */
export interface ParsedCommand {
  /** Lowercase command name without slash. */
  name: string
  /** Remaining command text. */
  arguments: string
}

/** Parse a single-leading-slash command; `//` is deliberately not a command. */
export function parseCommand(text: string): ParsedCommand | undefined {
  if (!text.startsWith('/') || text.startsWith('//')) return undefined
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text.trim())
  if (!match?.[1]) return undefined
  return { name: match[1].toLocaleLowerCase(), arguments: match[2]?.trim() ?? '' }
}
