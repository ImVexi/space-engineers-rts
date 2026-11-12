import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesignerSettingsPanel } from '../src/components/DesignerSettings';

const base = {
  draft: { simSpeedMin: 0.95, maxActive: 5 },
  liveSimSpeed: 1.02,
  simSpeedThreshold: 0.95,
  blocked: false,
  dirty: true,
  saving: false,
  error: null,
  onChange: () => {},
  onApply: () => {},
};

describe('DesignerSettingsPanel', () => {
  it('shows the editable floor next to the live SimSpeed', () => {
    const html = renderToStaticMarkup(<DesignerSettingsPanel {...base} />);
    expect(html).toContain('data-testid="designer-simspeed"');
    expect(html).toContain('0.95');
    expect(html).toContain('live SimSpeed 1.02');
    expect(html).toContain('Max active drones');
  });

  it('disables Apply until a limit changes', () => {
    const dirty = renderToStaticMarkup(<DesignerSettingsPanel {...base} />);
    expect(dirty).toContain('Apply limits');
    const clean = renderToStaticMarkup(<DesignerSettingsPanel {...base} dirty={false} />);
    expect(clean).toContain('Limits applied');
    expect(clean).toContain('disabled=""');
  });

  it('surfaces a SimSpeed gate block and an API error verbatim', () => {
    const html = renderToStaticMarkup(
      <DesignerSettingsPanel {...base} blocked={true} error="403: test-env lock" liveSimSpeed={null} />,
    );
    expect(html).toContain('BLOCKED');
    expect(html).toContain('403: test-env lock');
    expect(html).toContain('unknown');
  });
});
