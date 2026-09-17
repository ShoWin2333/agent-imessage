import type { ObjectValue } from './jsonrpc.js'

export interface SessionOptions {
  id?: string
  cwd: string
  model?: string
  approvalPolicy?: string
  speed?: string
  effort?: string
  tools: ObjectValue[]
}
export type BackendEvent =
  | { type: 'started'; sessionId: string; turnId: string }
  | { type: 'completed'; sessionId: string; turnId: string; status: 'completed' | 'interrupted' | 'failed'; failure?: 'session-busy' | 'authentication' | 'unknown' }
  | { type: 'message'; sessionId: string; turnId: string; id: string; text: string }
  | { type: 'changes'; sessionId: string; turnId: string; id: string; changes: unknown }
export interface BackendRequest {
  kind: 'tool' | 'command' | 'file' | 'approval' | 'question'
  sessionId: string
  turnId: string
  payload: ObjectValue
}
/** Adapters own execution only. No Photon, phone numbers, message delivery or persistence here. */
export interface Backend {
  initialize(): Promise<void>
  openSession(options: SessionOptions): Promise<{ id: string; cwd: string }>
  startTurn(sessionId: string, text: string): Promise<string>
  cancel(sessionId: string, turnId: string): Promise<void>
  close(): Promise<void>
  onEvent: (event: BackendEvent) => void
  onRequest: (request: BackendRequest) => Promise<unknown>
  onClose: () => void
}
export abstract class BaseBackend implements Backend {
  onEvent: Backend['onEvent'] = () => {}
  onRequest: Backend['onRequest'] = async () => { throw new Error('No owning turn') }
  onClose = () => {}
  abstract initialize(): Promise<void>
  abstract openSession(options: SessionOptions): Promise<{ id: string; cwd: string }>
  abstract startTurn(sessionId: string, text: string): Promise<string>
  abstract cancel(sessionId: string, turnId: string): Promise<void>
  abstract close(): Promise<void>
}
