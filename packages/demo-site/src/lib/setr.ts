/**
 * SETR terrain tile codec (CONTRACT-SHAPES §B).
 *
 * Header 16 bytes:
 *   magic b"SETR" | u32 version = 1 | u32 n (vertices per side) | f32 reserved
 * Then n*n u16 heights (little endian), 0..65535 mapped to
 * radius_min..radius_max, then n*n u8 biome/material class (0 = unknown).
 */
export const SETR_MAGIC = 'SETR'
export const SETR_VERSION = 1
export const SETR_HEADER_BYTES = 16
export const SETR_DEFAULT_RES = 65

export interface SetrTile {
  version: number
  /** vertices per side */
  n: number
  reserved: number
  heights: Uint16Array
  materials: Uint8Array
  byteLength: number
}

export class SetrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SetrError'
  }
}

export function decodeSetr(buffer: ArrayBuffer | ArrayBufferView): SetrTile {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (bytes.byteLength < SETR_HEADER_BYTES) {
    throw new SetrError(`SETR too short: ${bytes.byteLength} bytes`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  )
  if (magic !== SETR_MAGIC) throw new SetrError(`bad SETR magic: ${JSON.stringify(magic)}`)
  const version = view.getUint32(4, true)
  if (version !== SETR_VERSION) throw new SetrError(`unsupported SETR version: ${version}`)
  const n = view.getUint32(8, true)
  if (n < 2 || n > 1024) throw new SetrError(`bad SETR n: ${n}`)
  const reserved = view.getFloat32(12, true)
  const samples = n * n
  const expected = SETR_HEADER_BYTES + samples * 3
  if (bytes.byteLength !== expected) {
    throw new SetrError(`SETR length ${bytes.byteLength} != expected ${expected} for n=${n}`)
  }
  const heights = new Uint16Array(samples)
  const materials = new Uint8Array(samples)
  let off = SETR_HEADER_BYTES
  for (let i = 0; i < samples; i++) {
    heights[i] = view.getUint16(off, true)
    off += 2
  }
  materials.set(bytes.subarray(off, off + samples))
  return { version, n, reserved, heights, materials, byteLength: bytes.byteLength }
}

/** Encode a tile — used by unit tests and the mock backend. */
export function encodeSetr(n: number, heights: Uint16Array, materials?: Uint8Array): ArrayBuffer {
  if (heights.length !== n * n) throw new SetrError(`height count ${heights.length} != ${n * n}`)
  if (materials && materials.length !== n * n) throw new SetrError('material count mismatch')
  const buf = new ArrayBuffer(SETR_HEADER_BYTES + n * n * 3)
  const view = new DataView(buf)
  view.setUint8(0, 0x53)
  view.setUint8(1, 0x45)
  view.setUint8(2, 0x54)
  view.setUint8(3, 0x52)
  view.setUint32(4, SETR_VERSION, true)
  view.setUint32(8, n, true)
  view.setFloat32(12, 0, true)
  let off = SETR_HEADER_BYTES
  for (let i = 0; i < heights.length; i++) {
    view.setUint16(off, heights[i], true)
    off += 2
  }
  if (materials) for (let i = 0; i < materials.length; i++) view.setUint8(off + i, materials[i])
  return buf
}
