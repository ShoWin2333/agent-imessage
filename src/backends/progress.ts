/** Only fixed tool categories leave adapters; no tool inputs, results or thinking text. */
export function toolCategory(name: unknown): string {
  const names: Record<string,string> = {shell:'执行命令',commandExecution:'执行命令',execute:'执行命令',read:'读取文件',read_file:'读取文件',edit:'修改文件',write:'写入文件',fileChange:'修改文件',grep:'搜索内容',glob:'查找文件',search:'搜索内容',webSearch:'网页搜索',web_search:'网页搜索',mcpToolCall:'调用 MCP 工具',dynamicToolCall:'调用自定义工具'}
  return typeof name === 'string' && Object.hasOwn(names,name) ? names[name]! : '调用工具'
}
