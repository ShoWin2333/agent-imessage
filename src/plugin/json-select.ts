/** Streaming whitelist projection: skipped values are never decoded or retained. */
export async function selectJson(source: AsyncIterable<Uint8Array>, paths: readonly (readonly string[])[], maxBytes = 64 * 1024 * 1024, presenceOnly = false): Promise<Map<string, unknown>> {
  const iterator = source[Symbol.asyncIterator](), wanted = new Set(paths.map(p=>JSON.stringify(p))), result = new Map<string, unknown>()
  let chunk: Uint8Array = new Uint8Array(), offset = 0, total = 0
  const peek = async (): Promise<number> => { while(offset >= chunk.length) { const next=await iterator.next(); if(next.done)return -1; chunk=next.value;offset=0;total+=chunk.length;if(total>maxBytes)throw new Error('JSON input exceeds limit') } return chunk[offset]! }
  const take = async () => { const value=await peek();if(value<0)throw new Error('Truncated JSON');offset++;return value }
  const white = async () => { while([9,10,13,32].includes(await peek()))await take() }
  const raw = async (capture:boolean):Promise<unknown> => {
    const bytes:number[]=[]
    const emit=async()=>{const b=await take();if(capture){if(bytes.length>=1024*1024)throw new Error('Selected value exceeds limit');bytes.push(b)}return b}
    const string=async()=>{if(await emit()!==34)throw new Error('Invalid JSON string');while(true){const b=await emit();if(b===34)return;if(b===92)await emit();else if(b<32)throw new Error('Invalid JSON string')}}
    const skip=async(depth:number):Promise<void>=>{if(depth>64)throw new Error('JSON nesting exceeds limit');const b=await peek();if(b===34){await string();return}if(b===123||b===91){const close=b===123?125:93;await emit();while(true){const n=await peek();if(n===close){await emit();return}if(n<0)throw new Error('Truncated JSON');if(n===34)await string();else if(n===123||n===91)await skip(depth+1);else await emit()} }else{let n=0;while(true){const c=await peek();if(c<0||[9,10,13,32,44,93,125].includes(c))break;await emit();n++}if(!n)throw new Error('Invalid JSON scalar')}}
    await skip(0)
    return capture?JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))):undefined
  }
  const visit=async(path:string[],depth:number):Promise<void>=>{
    if(depth>64)throw new Error('JSON nesting exceeds limit');await white();const key=JSON.stringify(path)
    if(wanted.has(key)){if(result.has(key))throw new Error('Duplicate selected JSON field');if(presenceOnly){await raw(false);result.set(key,true)}else result.set(key,await raw(true));return}
    if(!paths.some(p=>path.every((v,i)=>p[i]===v))){await raw(false);return}
    const b=await take()
    if(b===123){await white();if(await peek()===125){await take();return}while(true){await white();if(await peek()!==34)throw new Error('Invalid JSON key');const name=await raw(true);if(typeof name!=='string')throw new Error('Invalid JSON key');await white();if(await take()!==58)throw new Error('Invalid JSON object');await visit([...path,name],depth+1);await white();const next=await take();if(next===125)return;if(next!==44)throw new Error('Invalid JSON object')}}
    else if(b===91){await white();if(await peek()===93){await take();return}let i=0;while(true){await visit([...path,String(i++)],depth+1);await white();const next=await take();if(next===93)return;if(next!==44)throw new Error('Invalid JSON array')}}
    else throw new Error('Expected JSON container')
  }
  try { await visit([],0);await white();if(await peek()!==-1)throw new Error('Trailing JSON input');return result } finally { await iterator.return?.() }
}
