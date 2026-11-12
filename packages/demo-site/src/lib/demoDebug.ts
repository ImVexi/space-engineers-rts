/**
 * Test probe for the hull-clean rule (CONTRACT-HULL):
 * a grid whose block model is in the scene must not be wrapped by a marker
 * sphere, a torus or a radio shell.
 *
 * The layers publish counters here; Playwright asserts that a focused grid has
 * zero halo geometry within 2x its bbox while its blocks stay drawn.
 */
export interface DemoDebug {
  /** grids whose blocks/bbox are in the scene */
  drawn: number;
  /** grids that exist in the save manifest (whether or not LOD draws them) */
  modeled: number;
  /** 3D marker dots still rendered (nodes without a block model) */
  markers: number;
  /** radio shells/rings still rendered */
  radioHalos: number;
  /** halo objects visible within 2x the focused grid's bbox: must be 0 */
  haloNearFocus: number;
  /** focused/selected grid id, `grid:` prefix stripped */
  focused: string | null;
  /** per-LOD grid counts, published by GridModelLayer */
  lod: { far: number; mid: number; near: number };
}

export const DEMO_DEBUG_DEFAULT: DemoDebug = {
  drawn: 0,
  modeled: 0,
  markers: 0,
  radioHalos: 0,
  haloNearFocus: 0,
  focused: null,
  lod: { far: 0, mid: 0, near: 0 },
};

/** Merge a patch into window.__demoDebug (never replaces sibling counters). */
export function publishDemoDebug(patch: Partial<DemoDebug>): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __demoDebug?: DemoDebug };
  const prev = w.__demoDebug ?? DEMO_DEBUG_DEFAULT;
  w.__demoDebug = {
    ...prev,
    ...patch,
    lod: { ...prev.lod, ...(patch.lod ?? {}) },
  };
}
