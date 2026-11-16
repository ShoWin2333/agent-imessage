import { sniffAudio, wrapWav } from './audio.js'

/** silk-wasm decodes to 16 kHz mono pcm_s16le, which is what wrapWav expects. */
const SILK_RATE = 16_000
/** Optional dependency: resolved at runtime so a profile without it still answers. */
const SPECIFIER = 'silk-wasm'

interface SilkModule {
  decode(input: Uint8Array, sampleRate: number): Promise<{ data: Uint8Array; duration: number }>
}

export type SilkDecodeResult = { ok: true; wav: Buffer } | { ok: false; reason: string }

/**
 * Tencent QQ voice messages use SILK v3, which ffmpeg cannot decode. The decoder
 * is optional: when it is absent the caller reports the missing capability
 * instead of sending undecodable bytes to the audio model.
 */
export async function decodeSilkToWav(bytes: Buffer, signal: AbortSignal): Promise<SilkDecodeResult> {
  if (sniffAudio(bytes) !== 'silk') return { ok: false, reason: '不是 SILK 音频' }
  let module: SilkModule
  try {
    module = await import(SPECIFIER) as unknown as SilkModule
  } catch {
    return { ok: false, reason: 'SILK 解码不可用：缺少 silk-wasm 依赖（腾讯 SILK 编码，ffmpeg 无法解码）。在该插件目录执行 pnpm add silk-wasm 即可启用。' }
  }
  signal.throwIfAborted()
  try {
    const decoded = await module.decode(new Uint8Array(bytes), SILK_RATE)
    signal.throwIfAborted()
    if (!decoded?.data?.length) return { ok: false, reason: 'SILK 解码结果为空' }
    return { ok: true, wav: wrapWav(Buffer.from(decoded.data)) }
  } catch (error) {
    return { ok: false, reason: `SILK 解码失败：${error instanceof Error ? error.message : '未知错误'}` }
  }
}
