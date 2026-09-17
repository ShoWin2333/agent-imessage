import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { object, type ObjectValue } from './jsonrpc.js'

/** Minimal stateless Streamable HTTP MCP transport, scoped to a single backend process. */
export async function startToolServer(tools: ObjectValue[], call: (name: string, args: ObjectValue) => Promise<unknown>) {
  const token = randomBytes(32).toString('hex')
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin || req.url !== '/mcp') { res.writeHead(403).end(); return }
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      let body = ''
      for await (const chunk of req) { body += String(chunk); if (body.length > 64_000) { res.writeHead(413).end(); return } }
      const message = object(JSON.parse(body)), params = object(message.params)
      if (message.id === undefined) { res.writeHead(202).end(); return }
      let result: unknown
      switch (message.method) {
        case 'initialize': result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agent-imessage', version: '1.0.0' } }; break
        case 'ping': result = {}; break
        case 'tools/list': result = { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }; break
        case 'tools/call': {
          if (!tools.some(t => t.name === params.name)) throw new Error('Unknown tool')
          const response = object(await call(String(params.name), object(params.arguments)))
          result = { content: [{ type: 'text', text: JSON.stringify(response) }], isError: response.success === false }; break
        }
        default: res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported method' } })); return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  return { url: `http://127.0.0.1:${address.port}/mcp`, token, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
