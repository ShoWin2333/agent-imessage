// Compatibility import for existing consumers; all routing lives in Gateway.
import { GatewayRouter } from '../gateway/router.js'
import { CodexBackend } from '../backends/codex.js'
import type { Rpc } from './rpc.js'
export class CodexRouter extends GatewayRouter {
  constructor(rpc: Rpc, ...args: ConstructorParameters<typeof GatewayRouter> extends [unknown, ...infer R] ? R : never) { super(new CodexBackend(rpc), ...args) }
}
