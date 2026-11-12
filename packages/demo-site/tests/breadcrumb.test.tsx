import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Breadcrumb } from '../src/components/Breadcrumb';
import { enterContext, initialStack, breadcrumb as breadcrumbFor } from '../src/lib/contextStack';
import type { ContextWorld } from '../src/lib/cameraContext';

const world: ContextWorld = {
  planets: [
    {
      id: 'p1',
      name: 'EarthLike',
      center: { x: 0, y: 0, z: 0 },
      surfaceRadiusM: 59_400,
      maxHillRadiusM: 67_200,
      hasAtmosphere: true,
    },
  ],
  nodes: [{ id: 'grid:1', name: 'SAT-L-0003', position: { x: 60_400, y: 0, z: 0 }, planet: 'EarthLike' }],
  groups: [{ id: 'g1', name: 'Group 1', members: ['grid:1'] }],
  names: { 'grid:1': 'SAT-L-0003' },
};

const pose = { yaw: 0.1, pitch: 0.2, distance: 5 };

function stack() {
  let s = initialStack();
  s = enterContext(s, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, pose);
  s = enterContext(s, { kind: 'group', id: 'g1', upMode: 'gravity' }, pose);
  s = enterContext(s, { kind: 'ship', id: 'grid:1', upMode: 'gravity' }, pose);
  return s;
}

describe('Breadcrumb', () => {
  it('renders every level as a clickable crumb with the active one marked', () => {
    const items = breadcrumbFor(stack(), world);
    const html = renderToStaticMarkup(
      <Breadcrumb items={items} description="orbiting SAT-L-0003 · up is local gravity" onJump={() => {}} onUp={() => {}} canUp />,
    );
    expect(html).toContain('data-testid="breadcrumb"');
    expect(html).toContain('data-depth="4"');
    for (const label of ['System', 'EarthLike', 'Group 1', 'SAT-L-0003']) expect(html).toContain(label);
    expect(html).toContain('data-testid="crumb-0"');
    expect(html).toContain('data-testid="crumb-3"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('data-testid="crumb-up"');
    expect(html).toContain('up is local gravity');
  });

  it('offers the gravity/ship up toggle at a ship level', () => {
    const items = breadcrumbFor(stack(), world);
    const gravity = renderToStaticMarkup(
      <Breadcrumb items={items} description="ship" onJump={() => {}} onUp={() => {}} canUp upMode="gravity" onUpMode={() => {}} />,
    );
    expect(gravity).toContain('data-testid="up-mode-toggle"');
    expect(gravity).toContain('data-up-mode="gravity"');
    expect(gravity).toContain('Up: gravity');
    const planet = renderToStaticMarkup(
      <Breadcrumb items={breadcrumbFor(initialStack(), world)} description="system" onJump={() => {}} onUp={() => {}} canUp={false} />,
    );
    expect(planet).not.toContain('up-mode-toggle');
  });

  it('offers no Up button at the top level', () => {
    const items = breadcrumbFor(initialStack(), world);
    const html = renderToStaticMarkup(
      <Breadcrumb items={items} description="orbiting the system centre" onJump={() => {}} onUp={() => {}} canUp={false} />,
    );
    expect(html).not.toContain('data-testid="crumb-up"');
    expect(html).toContain('data-depth="1"');
  });
});
