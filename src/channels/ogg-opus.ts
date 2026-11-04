/** A bounded, single logical Ogg Opus stream probe; no decoder or conversion. */
export function oggOpusDuration(bytes: Buffer): number | undefined {
  let offset = 0, sequence = 0, serial: number | undefined, preSkip = 0, packets = 0
  let pending: Buffer[] = [], pendingSize = 0, lastGranule = -1n, ended = false
  while (offset < bytes.length) {
    if (ended || offset + 27 > bytes.length || bytes.toString('ascii',offset,offset+4) !== 'OggS' || bytes[offset+4] !== 0) return
    const flags = bytes[offset+5]!, segments = bytes[offset+26]!, table = offset+27
    if ((flags & ~7) !== 0 || table+segments > bytes.length || segments === 0) return
    const stream = bytes.readUInt32LE(offset+14), pageSequence = bytes.readUInt32LE(offset+18)
    if (serial === undefined) {
      if (flags !== 2 || pageSequence !== 0) return
      serial = stream
    } else if (stream !== serial || (flags & 2) !== 0) return
    if (pageSequence !== sequence++ || Boolean(flags & 1) !== (pendingSize > 0)) return
    const granule = bytes.readBigUInt64LE(offset+6)
    let cursor = table+segments
    for (let index = 0; index < segments; index++) {
      const length = bytes[table+index]!
      if (cursor+length > bytes.length) return
      pending.push(bytes.subarray(cursor,cursor+length)); pendingSize += length; cursor += length
      // Opus packets are small; also bound malicious header/comment packets.
      if (pendingSize > 1024*1024) return
      if (length < 255) {
        const packet = Buffer.concat(pending,pendingSize)
        if (packets === 0) {
          if (packet.length < 19 || packet.toString('ascii',0,8) !== 'OpusHead' || packet[8] !== 1 || ![1,2].includes(packet[9]!) || packet[18] !== 0) return
          preSkip = packet.readUInt16LE(10)
        } else if (packets === 1) {
          if (packet.length < 16 || packet.toString('ascii',0,8) !== 'OpusTags') return
        } else if (packet.length === 0) return
        packets++; pending = []; pendingSize = 0
      }
    }
    if (granule !== 0xffffffffffffffffn) {
      if (granule < lastGranule) return
      lastGranule = granule
    }
    if (flags & 4) {
      if (pendingSize || packets < 3 || granule === 0xffffffffffffffffn || granule <= BigInt(preSkip)) return
      ended = true
    }
    offset = cursor
  }
  if (!ended || lastGranule > BigInt(Number.MAX_SAFE_INTEGER)) return
  const seconds = (Number(lastGranule)-preSkip)/48000
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}
