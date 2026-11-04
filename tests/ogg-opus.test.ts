import { expect, it } from 'vitest'
import { oggOpusDuration } from '../src/channels/ogg-opus.js'
import { opusFixture } from './voice-fixture.js'

it('derives Opus duration from final granule minus preskip at 48kHz',()=>{
  expect(oggOpusDuration(opusFixture(1))).toBe(1)
  expect(oggOpusDuration(opusFixture(0.02))).toBe(0.02)
  expect(oggOpusDuration(opusFixture(60))).toBe(60)
})
it('rejects truncated, chained, wrong-codec and inconsistent Ogg streams',()=>{
  const original=opusFixture()
  const mutate=(change:(bytes:Buffer)=>void)=>{const bytes=Buffer.from(original);change(bytes);return bytes}
  for (const invalid of [
    Buffer.alloc(0),Buffer.from('RIFF WAVE'),original.subarray(0,-1),Buffer.concat([original,original]),
    mutate(bytes=>{bytes[4]=1}),mutate(bytes=>{bytes[5]=0}),mutate(bytes=>{bytes[28]=0}),
    mutate(bytes=>{bytes[36]=2}),mutate(bytes=>{bytes[46]=1}),
    mutate(bytes=>{bytes.writeUInt32LE(8,47+18)}),mutate(bytes=>{bytes.writeUInt32LE(2,47+14)}),
    mutate(bytes=>{bytes[91+5]=0}),mutate(bytes=>{bytes.writeBigUInt64LE(0n,91+6)}),
  ]) expect(oggOpusDuration(invalid)).toBeUndefined()
})
