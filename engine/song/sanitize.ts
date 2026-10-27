/**
 * Repairs common damage in MIDI files that strict parsers reject: end-of-track events with a
 * non-zero length, and junk appended after the last track (e.g. "Created by …" text).
 */
export function sanitizeMidi(data: ArrayBuffer | Uint8Array): Uint8Array {
  const src = data instanceof Uint8Array ? data : new Uint8Array(data)
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const tag = (o: number) => String.fromCharCode(...src.subarray(o, o + 4))
  if (src.length < 14 || tag(0) !== 'MThd') return src

  const headerLen = 8 + view.getUint32(4)
  const chunks: Uint8Array[] = [src.subarray(0, headerLen)]
  let changed = false
  let o = headerLen
  while (o + 8 <= src.length && tag(o) === 'MTrk') {
    const len = view.getUint32(o + 4)
    const end = Math.min(src.length, o + 8 + len)
    const chunk = src.slice(o, end)

    if (end !== o + 8 + len) {
      new DataView(chunk.buffer).setUint32(4, end - o - 8)
      changed = true
    }

    // Last three bytes should read FF 2F 00.
    const n = chunk.length
    if (n >= 11 && chunk[n - 3] === 0xff && chunk[n - 2] === 0x2f && chunk[n - 1] !== 0) {
      chunk[n - 1] = 0
      changed = true
    }

    chunks.push(chunk)
    o = end
  }

  if (o < src.length) changed = true
  if (!changed) return src

  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
