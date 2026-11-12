import { describe, expect, it } from 'vitest'
import {
  CATEGORY_COLORS,
  fallbackSubtypeInfo,
  humanizeSubtype,
  inferCategory,
  inferShape,
  normaliseSubtypeInfo,
  resolveSubtypeTable,
} from '../../src/lib/subtypeInfo'
import { SHAPE_CLASSES } from '../../src/lib/shapes'

describe('subtype metadata', () => {
  it('humanises SubtypeIds', () => {
    expect(humanizeSubtype('LargeBlockArmorSlope2Tip')).toBe('Armor Slope 2 Tip')
    expect(humanizeSubtype('SmallBlockWindow')).toBe('Window')
    expect(humanizeSubtype('Catwalk')).toBe('Catwalk')
  })

  it('infers every contracted shape class from names', () => {
    const cases: Array<[string, string]> = [
      ['LargeBlockArmorBlock', 'cube'],
      ['LargeBlockArmorHalfBlock', 'half'],
      ['LargeBlockArmorSlope', 'slope'],
      ['LargeBlockArmorCorner', 'corner'],
      ['LargeBlockArmorInvCorner', 'invcorner'],
      ['LargeBlockArmorSlope2Base', 'slope2base'],
      ['LargeBlockArmorSlope2Tip', 'slope2tip'],
      ['LargeBlockArmorCorner2Base', 'corner2base'],
      ['LargeBlockArmorCorner2Tip', 'corner2tip'],
      ['LargeBlockArmorHalfSlope', 'halfslope'],
      ['LargeBlockArmorPanel', 'panel'],
      ['LargeBlockArmorHalfPanel', 'halfpanel'],
      ['LargeBlockBeam', 'beam'],
      ['Catwalk', 'catwalk'],
      ['LargeBlockWindow', 'window'],
      ['LargeBlockCylinder', 'cylinder'],
    ]
    for (const [name, shape] of cases) expect(inferShape(name), name).toBe(shape)
    for (const name of ['LargeBlockArmorBlock', 'LargeBlockArmorSlope', 'Catwalk', 'LargeBlockWindow']) {
      expect(SHAPE_CLASSES).toContain(inferShape(name))
    }
    // order matters: halfslope wins over slope
    expect(inferShape('LargeBlockArmorHalfSlope')).toBe('halfslope')
  })

  it('infers categories from subtype and type names', () => {
    expect(inferCategory('LargeBlockArmorBlock')).toBe('armor')
    expect(inferCategory('LargeBlockSmallThrust')).toBe('thruster')
    expect(inferCategory('LargeBlockLargeGenerator')).toBe('power')
    expect(inferCategory('LargeBlockAssembler')).toBe('production')
    expect(inferCategory('LargeBlockCargoContainer')).toBe('storage')
    expect(inferCategory('LargeBlockConveyor')).toBe('conveyor')
    expect(inferCategory('LargeBlockInteriorTurret')).toBe('weapon')
    expect(inferCategory('LargeBlockCockpit')).toBe('control')
    expect(inferCategory('LargeBlockAntenna')).toBe('comms')
    expect(inferCategory('LargeBlockCamera')).toBe('sensor')
    expect(inferCategory('LargeBlockDoor')).toBe('door')
    expect(inferCategory('SmallLight')).toBe('light')
    expect(inferCategory('LargeBlockPistonBase')).toBe('mechanical')
    expect(inferCategory('LargeBlockWheelSuspension')).toBe('wheel')
    expect(inferCategory('LargeBlockMedicalStation')).toBe('medical')
    expect(inferCategory('LargeBlockCatwalk')).toBe('structure')
    expect(inferCategory('WidgetAlpha')).toBe('other')
  })

  it('falls back per field instead of rejecting a bad backend entry', () => {
    const info = normaliseSubtypeInfo(
      { display: 'Big Thruster', category: 'thruster', shape: 'not-a-shape', size: [0, -2, 3] },
      'LargeBlockSmallThrust',
    )
    expect(info.display).toBe('Big Thruster')
    expect(info.category).toBe('thruster')
    expect(info.shape).toBe('cube') // inferred fallback (thrust has no shape hint)
    expect(info.size).toEqual([1, 1, 3])
    expect(fallbackSubtypeInfo('LargeBlockArmorSlope2Base').size).toEqual([2, 1, 1])
  })

  it('resolves a parallel subtype table and keeps every category coloured', () => {
    const table = resolveSubtypeTable(['Catwalk', 'LargeBlockSmallThrust'], [
      { name: 'Catwalk', display: 'Catwalk', type: 'CubeBlock', category: 'structure', shape: 'catwalk', size: [1, 1, 1], center: null },
    ])
    expect(table[0].shape).toBe('catwalk')
    expect(table[1].category).toBe('thruster')
    for (const key of Object.keys(CATEGORY_COLORS)) {
      expect(CATEGORY_COLORS[key as keyof typeof CATEGORY_COLORS]).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
