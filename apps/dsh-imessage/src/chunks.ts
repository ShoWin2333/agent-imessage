/** Split outbound text at paragraph/line/space boundaries without breaking grapheme clusters. */
export function chunkText(text: string, maximum: number): string[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError('maximum must be a positive integer')
  if (text.length === 0) return []

  const graphemes = segmentGraphemes(text)
  const chunks: string[] = []
  let cursor = 0
  while (cursor < graphemes.length) {
    const end = Math.min(cursor + maximum, graphemes.length)
    if (end === graphemes.length) {
      chunks.push(graphemes.slice(cursor).join(''))
      break
    }
    let split = findBoundary(graphemes, cursor, end, '\n\n')
    split ??= findBoundary(graphemes, cursor, end, '\n')
    split ??= findBoundary(graphemes, cursor, end, ' ')
    const next = split !== undefined && split > cursor ? split : end
    const value = graphemes.slice(cursor, next).join('').trimEnd()
    if (value.length > 0) chunks.push(value)
    cursor = next
  }
  return chunks
}

function segmentGraphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return [...segmenter.segment(text)].map(item => item.segment)
}

function findBoundary(parts: string[], start: number, end: number, boundary: string): number | undefined {
  const candidate = parts.slice(start, end).join('')
  const index = candidate.lastIndexOf(boundary)
  if (index < 0) return undefined
  const prefix = candidate.slice(0, index + boundary.length)
  if (prefix.trim().length === 0) return undefined
  return start + segmentGraphemes(prefix).length
}
