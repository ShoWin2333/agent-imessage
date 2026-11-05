// Adapted from Tencent Connect dsh-qqbot, MIT; see THIRD_PARTY_NOTICES.md.
import {extname} from 'node:path'
export function imageExtension(buf: Buffer): string | undefined {
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return '.gif';
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 12
    && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp';
  return undefined;
}

/**
 * 按图片真实格式修正路径扩展名，保留文件名主体（纯函数）。
 * 未识别 / 已一致 / jpg≈jpeg 时原样返回，避免无意义改名。
 */
export function correctImageExt(path: string, buf: Buffer): string {
  const realExt = imageExtension(buf);
  const ext = extname(path);
  const declaredExt = ext.toLowerCase();
  if (!realExt || declaredExt === realExt || (realExt === '.jpg' && declaredExt === '.jpeg')) return path;
  return `${path.slice(0, path.length - ext.length)}${realExt}`;
}
