/**
 * 扫码 URL → SVG data URL（宿主侧渲染）
 *
 * 二维码图像在宿主生成而非浏览器：客户端 bundle 保持零第三方依赖
 * （externals 仅平台种子表），且二维码由可信源编码，页面无伪造面。
 *
 * qrcode 是 CJS 包，用 createRequire 直接取 module.exports，绕开宿主
 * 加载链下不稳定的 ESM interop。加载放在首次渲染时：任何异常只让本次
 * 渲染抛错（页面提示重启并提供浏览器链接），不影响插件启动。
 */
import { createRequire } from 'node:module';

/** qrcode 的最小 API 面 */
interface QrApi {
  toString(text: string, options?: unknown): Promise<string>;
}

let cachedApi: QrApi | undefined;

function loadQrApi(): QrApi {
  cachedApi ??= createRequire(import.meta.url)('qrcode') as QrApi;
  return cachedApi;
}

/** 二维码渲染参数（输出 SVG，含 1 单位留白，240px 宽度适合侧栏展示） */
const QR_OPTIONS = { type: 'svg' as const, margin: 1, width: 240 };

/**
 * 将绑定 URL 渲染为 SVG data URL，供端内绑定页 <img> 直接使用。
 *
 * @param url - 二维码内容（q.qq.com 的 connect.html 链接）
 * @returns `data:image/svg+xml;base64,...` 形式的 data URL
 * @throws qrcode 加载失败或渲染结果非 SVG
 */
export async function renderQrSvgDataUrl(url: string): Promise<string> {
  const svg = await loadQrApi().toString(url, QR_OPTIONS);
  if (typeof svg !== 'string' || !svg.trimStart().startsWith('<svg')) {
    throw new Error(`unexpected QRCode.toString result (${typeof svg})`);
  }
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
