import * as THREE from 'three'
import type { Quat, Vec3 } from './worldMapTypes'

/**
 * SEGB block geometry asset (CONTRACT-BLOCKS §World geometry API).
 *
 * Little-endian layout:
 *   header 16 B: magic "SEGB", u32 version = 1, u32 count, f32 grid_size_m
 *   count × 12 B: i16 min_x, min_y, min_z, u16 subtype_idx, u8 r, u8 g, u8 b, u8 orient
 */
export const SEGB_MAGIC = 'SEGB'
export const SEGB_VERSION = 1
export const SEGB_HEADER_BYTES = 16
export const SEGB_RECORD_BYTES = 12

export interface SegbAsset {
  version: number
  /** metres per cell (2.5 = Large, 0.5 = Small) */
  gridSizeM: number
  count: number
  /** min-cell coordinates, 3 int16 per block */
  min: Int16Array
  subtype: Uint16Array
  /** 0..255 rgb, 3 per block */
  color: Uint8Array
  /** 0..23 Forward/Up index, 0 = identity */
  orient: Uint8Array
  byteLength: number
}

export interface EncodableBlock {
  x: number
  y: number
  z: number
  subtype?: number
  r: number
  g: number
  b: number
  orient?: number
}

export class SegbError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SegbError'
  }
}

function readMagic(view: DataView): string {
  return (
    String.fromCharCode(view.getUint8(0)) +
    String.fromCharCode(view.getUint8(1)) +
    String.fromCharCode(view.getUint8(2)) +
    String.fromCharCode(view.getUint8(3))
  )
}

/** Decode a SEGB buffer. Throws SegbError on malformed input. */
export function decodeSegb(buffer: ArrayBuffer | ArrayBufferView): SegbAsset {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (bytes.byteLength < SEGB_HEADER_BYTES) {
    throw new SegbError(`SEGB too short: ${bytes.byteLength} bytes`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = readMagic(view)
  if (magic !== SEGB_MAGIC) throw new SegbError(`bad SEGB magic: ${JSON.stringify(magic)}`)
  const version = view.getUint32(4, true)
  if (version !== SEGB_VERSION) throw new SegbError(`unsupported SEGB version: ${version}`)
  const count = view.getUint32(8, true)
  const gridSizeM = view.getFloat32(12, true)
  if (!Number.isFinite(gridSizeM) || gridSizeM <= 0) {
    throw new SegbError(`bad SEGB grid_size_m: ${gridSizeM}`)
  }
  const expected = SEGB_HEADER_BYTES + count * SEGB_RECORD_BYTES
  if (bytes.byteLength !== expected) {
    throw new SegbError(`SEGB length ${bytes.byteLength} != expected ${expected} for ${count} blocks`)
  }

  const min = new Int16Array(count * 3)
  const subtype = new Uint16Array(count)
  const color = new Uint8Array(count * 3)
  const orient = new Uint8Array(count)

  let off = SEGB_HEADER_BYTES
  for (let i = 0; i < count; i++) {
    min[i * 3] = view.getInt16(off, true)
    min[i * 3 + 1] = view.getInt16(off + 2, true)
    min[i * 3 + 2] = view.getInt16(off + 4, true)
    subtype[i] = view.getUint16(off + 6, true)
    color[i * 3] = view.getUint8(off + 8)
    color[i * 3 + 1] = view.getUint8(off + 9)
    color[i * 3 + 2] = view.getUint8(off + 10)
    orient[i] = view.getUint8(off + 11)
    off += SEGB_RECORD_BYTES
  }

  return { version, gridSizeM, count, min, subtype, color, orient, byteLength: bytes.byteLength }
}

/** Encode blocks as SEGB — used by tests and offline fixtures. */
export function encodeSegb(gridSizeM: number, blocks: EncodableBlock[]): ArrayBuffer {
  const buf = new ArrayBuffer(SEGB_HEADER_BYTES + blocks.length * SEGB_RECORD_BYTES)
  const view = new DataView(buf)
  view.setUint8(0, 0x53) // S
  view.setUint8(1, 0x45) // E
  view.setUint8(2, 0x47) // G
  view.setUint8(3, 0x42) // B
  view.setUint32(4, SEGB_VERSION, true)
  view.setUint32(8, blocks.length, true)
  view.setFloat32(12, gridSizeM, true)
  let off = SEGB_HEADER_BYTES
  for (const b of blocks) {
    view.setInt16(off, b.x, true)
    view.setInt16(off + 2, b.y, true)
    view.setInt16(off + 4, b.z, true)
    view.setUint16(off + 6, b.subtype ?? 0, true)
    view.setUint8(off + 8, b.r)
    view.setUint8(off + 9, b.g)
    view.setUint8(off + 10, b.b)
    view.setUint8(off + 11, b.orient ?? 0)
    off += SEGB_RECORD_BYTES
  }
  return buf
}

/** Centre of a block in grid-local scene units (km). */
export function blockLocalCentre(
  minX: number,
  minY: number,
  minZ: number,
  gridSizeM: number,
): { x: number; y: number; z: number } {
  const s = gridSizeM / 1000
  return { x: (minX + 0.5) * s, y: (minY + 0.5) * s, z: (minZ + 0.5) * s }
}

/** Rotate v by quaternion (x,y,z,w) — same right-handed convention as VRage. */
export function rotateByQuat(v: Vec3, q: Quat): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/**
 * World position of a block centre in metres, exactly as the backend defines it:
 *   gridPos + R(quat) · ((Min + 0.5) · gridSize)
 */
export function gridWorldCentre(pos: Vec3, quat: Quat, min: Vec3, gridSizeM: number): Vec3 {
  const local = { x: (min.x + 0.5) * gridSizeM, y: (min.y + 0.5) * gridSizeM, z: (min.z + 0.5) * gridSizeM }
  const rotated = rotateByQuat(local, quat)
  return { x: pos.x + rotated.x, y: pos.y + rotated.y, z: pos.z + rotated.z }
}

/** Convenience: manifest quaternion as a THREE quaternion (order x,y,z,w). */
export function toThreeQuat(q: Quat): THREE.Quaternion {
  return new THREE.Quaternion(q.x, q.y, q.z, q.w)
}
