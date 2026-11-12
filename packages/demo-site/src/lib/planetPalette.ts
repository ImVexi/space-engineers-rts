/** Deterministic 32-bit FNV-1a style hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function hueFor(key: string): number {
  return hashString(key) % 360
}

/** Stable HSL colour per faction (or per entity when unaffiliated). */
export function factionColor(tag: string | null | undefined, key?: string): string {
  const seed = tag && tag.length > 0 ? tag : key ?? 'unaffiliated'
  const hue = tag && tag.length > 0 ? hueFor(tag) : 210
  const sat = tag && tag.length > 0 ? 68 : 12
  const light = tag && tag.length > 0 ? 62 : 62
  return `hsl(${hue} ${sat}% ${light}%)` // seed kept for readability in debug
}

export function factionHue(tag: string | null | undefined): number | null {
  if (!tag) return null
  return hueFor(tag)
}

const PLANET_COLORS: Array<[RegExp, string, string]> = [
  [/earth/i, '#3f8f68', '#2b6fa8'],
  [/mars/i, '#b4471f', '#c96a3a'],
  [/moon|luna/i, '#9aa3ab', '#c3c9cf'],
  [/europa/i, '#bfe0ee', '#7fb6cc'],
  [/alien|pertam|magma/i, '#8a5bd6', '#5c3aa0'],
  [/titan/i, '#d98536', '#9a531c'],
  [/asteroid|rock/i, '#6b7280', '#4b5563'],
]

export interface PlanetPalette {
  base: string
  accent: string
}

export function planetPalette(name: string): PlanetPalette {
  for (const [re, base, accent] of PLANET_COLORS) {
    if (re.test(name)) return { base, accent }
  }
  return { base: '#5b7fa8', accent: '#7aa6c9' }
}

export function statusColor(status: string): string {
  switch (status) {
    case 'online':
      return '#3ddc84'
    case 'stale':
      return '#f5b942'
    case 'offline':
      return '#7b8794'
    default:
      return '#7b8794'
  }
}
