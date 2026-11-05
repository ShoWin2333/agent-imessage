// Adapted from tencent-connect/dsh-qqbot, MIT; see THIRD_PARTY_NOTICES.md.
/**
 * Markdown 文本切分器
 *
 * QQ 单条消息有字符数限制（约 5000），需要在合适边界切分，
 * 并保持 GFM 表格、代码块的完整性。
 */

const CODE_FENCE_OPEN = /^```/;
const GFM_TABLE_LINE = /^\|.+\|$/;

/**
 * 按换行边界切分 Markdown 文本
 * - 不在代码块中间断开
 * - 不在 GFM 表格中间断开
 * - 优先在空行处断开
 */
export function chunkMarkdownText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  let inCodeBlock = false;
  let tableBuffer: string[] = [];

  const flushTable = (): void => {
    if (tableBuffer.length === 0) return;
    const block = tableBuffer.join('\n');
    tableBuffer = [];

    if (!current) {
      current = block;
      return;
    }

    const candidate = `${current}\n${block}`;
    if (candidate.length > limit) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  };

  const appendLine = (line: string): void => {
    if (!current) {
      current = line;
      return;
    }
    const candidate = `${current}\n${line}`;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  };

  for (const line of lines) {
    if (CODE_FENCE_OPEN.test(line)) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      appendLine(line);
      continue;
    }

    if (inCodeBlock) {
      appendLine(line);
      continue;
    }

    if (GFM_TABLE_LINE.test(line)) {
      tableBuffer.push(line);
      continue;
    }

    flushTable();
    appendLine(line);
  }

  flushTable();
  if (current) chunks.push(current);

  // The upstream chunker preserves logical blocks but can emit an oversized line/table.
  // Enforce the platform ceiling without breaking Unicode graphemes.
  return (chunks.length > 0 ? chunks : [text]).flatMap(block => {
    if(block.length<=limit)return [block];
    const pieces:string[]=[];let part='';
    for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(block)){
      if(part.length+segment.length>limit){pieces.push(part);part='';}
      part+=segment;
    }
    if(part)pieces.push(part);return pieces;
  });
}
