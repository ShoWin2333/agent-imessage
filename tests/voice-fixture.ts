/** Synthetic single-stream Ogg Opus headers/granules; never sent to a real provider. */
export function opusFixture(seconds = 1): Buffer {
  const head = Buffer.alloc(19)
  head.write('OpusHead'); head[8] = 1; head[9] = 1; head.writeUInt16LE(312,10)
  const tags = Buffer.alloc(16); tags.write('OpusTags')
  const page = (packet: Buffer, sequence: number, flags: number, granule: bigint) => {
    const header = Buffer.alloc(28)
    header.write('OggS'); header[5] = flags; header.writeBigUInt64LE(granule,6)
    header.writeUInt32LE(1,14); header.writeUInt32LE(sequence,18); header[26] = 1; header[27] = packet.length
    return Buffer.concat([header,packet])
  }
  return Buffer.concat([page(head,0,2,0n),page(tags,1,0,0n),page(Buffer.from([0xf8,0xff,0xfe]),2,4,BigInt(Math.round(seconds*48000)+312))])
}
