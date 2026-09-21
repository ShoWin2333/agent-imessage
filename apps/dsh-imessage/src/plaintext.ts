/**
 * Convert markdown into readable plain text for text-only iMessage delivery.
 *
 * Formatting markers are removed while line structure is preserved. Fenced
 * code blocks and inline code keep their exact contents, and ordinary plain
 * text passes through unchanged apart from harmless whitespace tidying.
 */

const ESCAPED_PREFIX = '\u0000dsh-md-escaped-'
const INLINE_CODE_PREFIX = '\u0000dsh-md-code-'
const FENCE_PREFIX = '\u0000dsh-md-fence-'
const MARKER_SUFFIX = '\u0000'

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)\n([\s\S]*?)^ {0,3}\1+[ \t]*$/gm
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const RULE_RE = /^ {0,3}(?:=+|-{2,}|\*{2,}|_{2,})[ \t]*$/
const QUOTE_RE = /^[ \t]*>[ \t]?/
const LINK_DEFINITION_RE = /^ {0,3}\[[^\]]+\]:[ \t]+(?:<[^>]*>|\S+)/
const ESCAPABLE_RE = /\\([\\`*_{}\[\]()#+\-.!|>~])/g
const AUTOLINK_RE = /<([a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]+)>/g
const EMAIL_RE = /<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/g
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+["'][^"']*["'])?\)/g
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:[ \t]+["'][^"']*["'])?\)/g
const REFERENCE_LINK_RE = /\[([^\]]+)\]\[[^\]]*\]/g
const INLINE_CODE_RE = /(`+)([\s\S]*?)\1/g
const BR_RE = /<br\s*\/?>/gi
const TAG_RE = /<\/?[a-zA-Z][^>]*>/g
const NUMERIC_ENTITY_RE = /&#(\d+);/g

/** Strip one emphasis/strikethrough delimiter run (`**`, `*`, `_`, `~~`). */
function stripDelimited(text: string, char: string, count: number): string {
  const delimiter = char.repeat(count)
  const escaped = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<![\\w${char}])${escaped}(?![\\s${char}])([\\s\\S]+?)(?<![\\s${char}])${escaped}(?![\\w])`,
    'g',
  )
  return text.replace(pattern, '$1')
}

/** Render one table row as pipe-separated plain text, dropping delimiter rows. */
function renderTableRow(line: string): string {
  const cells = line.split(/(?<!\\)\|/u).map(cell => cell.trim())
  while (cells.length > 0 && cells[0] === '') cells.shift()
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  if (cells.every(cell => /^:?-+:?$/u.test(cell))) return ''
  return cells.join(' | ')
}

/** Convert one markdown document into plain text. */
export function markdownToPlainText(text: string): string {
  if (text.length === 0) return text

  // Fenced code blocks keep their exact contents: extract them first so every
  // later pass leaves them alone, then restore them at the very end.
  const fences: string[] = []
  const withoutFences = text.replace(/\r\n?/g, '\n').replace(FENCE_RE, (_match, _fence, _info, body) => {
    const index = fences.length
    fences.push(body.replace(/\n$/, ''))
    return `${FENCE_PREFIX}${index}${MARKER_SUFFIX}`
  })

  const result: string[] = []
  for (const raw of withoutFences.split('\n')) {
    const line = raw.replace(/[ \t]+$/u, '')
    let unquoted = line
    while (QUOTE_RE.test(unquoted)) unquoted = unquoted.replace(QUOTE_RE, '')
    const heading = HEADING_RE.exec(unquoted)
    if (heading !== null) {
      result.push(heading[2] ?? '')
      continue
    }
    if (unquoted.includes('|')) {
      result.push(renderTableRow(unquoted))
      continue
    }
    if (RULE_RE.test(unquoted)) continue
    if (LINK_DEFINITION_RE.test(unquoted)) continue
    result.push(unquoted)
  }

  let plain = result.join('\n')
  const escapes: string[] = []
  const codes: string[] = []

  // Protect backslash escapes so `\*`, `\#`, ... survive the inline passes.
  plain = plain.replace(ESCAPABLE_RE, (_match, char) => {
    const index = escapes.length
    escapes.push(char)
    return `${ESCAPED_PREFIX}${index}${MARKER_SUFFIX}`
  })
  plain = plain
    .replace(AUTOLINK_RE, '$1')
    .replace(EMAIL_RE, '$1')
    .replace(IMAGE_RE, '$1')
    .replace(LINK_RE, '$1 ($2)')
    .replace(REFERENCE_LINK_RE, '$1')
    .replace(INLINE_CODE_RE, (_match, _delimiter, content) => {
      const index = codes.length
      codes.push(content.trim())
      return `${INLINE_CODE_PREFIX}${index}${MARKER_SUFFIX}`
    })
  plain = stripDelimited(plain, '*', 3)
  plain = stripDelimited(plain, '_', 3)
  plain = stripDelimited(plain, '*', 2)
  plain = stripDelimited(plain, '_', 2)
  plain = stripDelimited(plain, '~', 2)
  plain = stripDelimited(plain, '*', 1)
  plain = stripDelimited(plain, '_', 1)
  plain = plain
    .replace(BR_RE, '\n')
    .replace(TAG_RE, '')
    .replace(NUMERIC_ENTITY_RE, (_match, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')

  for (let index = 0; index < codes.length; index += 1) {
    plain = plain.replaceAll(`${INLINE_CODE_PREFIX}${index}${MARKER_SUFFIX}`, codes[index] ?? '')
  }
  for (let index = 0; index < escapes.length; index += 1) {
    plain = plain.replaceAll(`${ESCAPED_PREFIX}${index}${MARKER_SUFFIX}`, escapes[index] ?? '')
  }
  for (let index = 0; index < fences.length; index += 1) {
    plain = plain.replaceAll(`${FENCE_PREFIX}${index}${MARKER_SUFFIX}`, fences[index] ?? '')
  }
  return plain.trim()
}
