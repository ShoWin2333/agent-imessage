import {afterEach, beforeEach, expect, vi} from 'vitest'

// A missed adapter mock must fail locally, even if production catches the error.
let blockedFetch: ReturnType<typeof vi.fn>
beforeEach(()=>{
  blockedFetch=vi.fn(async()=>{throw new Error('Offline tests forbid unmocked fetch')})
  vi.stubGlobal('fetch',blockedFetch)
})
afterEach(()=>{
  try {expect(blockedFetch).not.toHaveBeenCalled()} finally {vi.unstubAllGlobals()}
})
