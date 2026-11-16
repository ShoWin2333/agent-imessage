import type { NativeResult, Receipt } from '../bridge.js'

const comparable = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim()

/** Remove only complete, identical transcript paragraphs, never semantic guesses. */
function omitTranscript(text: string, transcript: string): string {
  const target = comparable(transcript)
  if (!target) return text
  const paragraphs = text.trim().split(/\n\s*\n/)
  for (let start = 0; start < paragraphs.length; start++) {
    for (let end = start + 1; end <= paragraphs.length; end++) {
      const candidate = comparable(paragraphs.slice(start, end).join('\n\n'))
      if (candidate === target) {
        paragraphs.splice(start, end - start)
        start--
        break
      }
      if (candidate.length > target.length) break
    }
  }
  return paragraphs.join('\n\n').trim()
}

/** Presentation only: the original assistant and tool results stay in DSH history. */
export function voiceAwareResult(result: NativeResult, receipt: Receipt | undefined, recovering = false): NativeResult {
  if (result.suppressed || !receipt?.voice || !['completed', 'ended'].includes(result.reason)) return result
  // New coordinated replies represent the terminal Agent script, not earlier
  // step preambles collected by legacy native result inspection.
  if (recovering && receipt.voice.final) result = { ...result, text: receipt.voice.text }
  const media = receipt.media?.find(item => item.callId === receipt.voice!.callId)
  if (media?.delivery !== 'sent') {
    // An ambiguous upload is not proof that the user heard anything. Keep the
    // Agent's answer, or provide the transcript, and explicitly report status.
    const status = media ? '语音投递未确认（可能已送达），未自动重发。' : '语音未开始投递，未自动重发。'
    return result.text.trim().endsWith(status) ? result
      : { ...result, text: `${result.text.trim() || receipt.voice.text}\n\n${status}`.trim() }
  }
  const text = omitTranscript(result.text, receipt.voice.text)
  return { ...result, text, ...(text ? {} : { suppressed: true }) }
}
