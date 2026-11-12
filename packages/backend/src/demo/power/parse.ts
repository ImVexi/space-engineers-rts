/**
 * Parse the plugin `profile` result into a `PowerSnapshot`.
 *
 * The plugin is the source of truth; this file only normalises what it sends
 * and never invents a number. A field the profile did not report stays `null`
 * and its name is added to `missing`, so the site can render "—" instead of a
 * plausible-looking guess.
 */
import type { ChargeState, PowerReactor, PowerSnapshot, PowerSolar, PowerTank, SectionState } from './types.js';

type Dict = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const arr = (v: unknown): Dict[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Dict[]) : []);

/** The plugin uses -1 as an "unknown" sentinel for ratios it could not compute. */
function ratio(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
}

function chargeOf(raw: unknown, inputMw: number | null, outputMw: number | null, netMw: number | null): ChargeState {
  const text = str(raw)?.toLowerCase() ?? null;
  if (text) {
    if (text.includes('charg') && !text.includes('dis')) return 'charging';
    if (text.includes('discharg') || text.includes('drain')) return 'discharging';
    if (text.includes('idle') || text.includes('stand')) return 'idle';
  }
  if (inputMw !== null && inputMw > 0.0005 && (outputMw === null || inputMw >= outputMw)) return 'charging';
  if (outputMw !== null && outputMw > 0.0005) return 'discharging';
  if (netMw !== null) return netMw > 0.0005 ? 'charging' : netMw < -0.0005 ? 'discharging' : 'idle';
  return 'unknown';
}

export function parseProfileResult(gridId: string, result: Dict, at: number): PowerSnapshot {
  const powerRaw = result.power;
  const fuelRaw = result.fuel;
  const power = (powerRaw && typeof powerRaw === 'object' ? powerRaw : {}) as Dict;
  const fuel = (fuelRaw && typeof fuelRaw === 'object' ? fuelRaw : {}) as Dict;
  const control = (result.control ?? {}) as Dict;

  const tanks: PowerTank[] = arr(fuel.tanks).map((t) => ({
    name: str(t.name) ?? 'tank',
    subtype: str(t.subtype) ?? '',
    filledRatio: num(t.filledRatio),
    filledL: num(t.filledL),
    capacityL: num(t.capacity),
    stockpile: t.stockpile === true,
    readState: t.readState === 'unread' || num(t.filledRatio) === null ? 'unread' : 'read',
    unreadReason: str(t.unreadReason) ?? (num(t.filledRatio) === null ? 'plugin did not report a fill ratio' : null),
    container: str(t.container),
  }));
  const h2Tanks = tanks.filter((t) => /hydrogen|h2/i.test(`${t.subtype} ${t.name}`));
  // Never fall back to non-hydrogen tanks: an oxygen tank's fill is not fuel,
  // and reporting it as H2 % is how a full ship looked empty.
  const useTanks = h2Tanks;
  const unreadReasons = (section: Dict): string[] =>
    arr(section.unread)
      .map((u) => str(u.error) ?? str(u.reason))
      .filter((v): v is string => v !== null);
  const reasonsFor = (list: PowerTank[]): string[] => list.map((t) => t.unreadReason).filter((v): v is string => v !== null);
  const sum = (values: (number | null)[]): number | null => {
    if (values.length === 0 || values.some((v) => v === null)) return null;
    return values.reduce<number>((a, b) => a + (b ?? 0), 0);
  };

  const reactors: PowerReactor[] = arr(power.reactors).map((r) => ({
    name: str(r.name) ?? 'reactor',
    outputMw: num(r.outputMw),
    maxOutputMw: num(r.maxOutputMw),
    uraniumKg: num(r.uraniumKg),
    uraniumCapacityKg: num(r.uraniumCapacityKg),
  }));
  const solar: PowerSolar[] = arr(power.solar).map((s) => ({
    name: str(s.name) ?? 'solar',
    actualMw: num(s.actualMw),
    maxMw: num(s.maxMw),
  }));

  const radio = arr(result.radio).map((r) => ({
    name: str(r.name) ?? 'antenna',
    radiusM: num(r.radiusM),
    drawMw: num(r.drawMw),
    enabled: r.enabled !== false,
  }));
  const lasers = arr(result.laser).map((l) => ({
    name: str(l.name) ?? 'laser',
    rangeM: num(l.rangeM),
    drawMw: num(l.drawMw),
    status: str(l.status),
  }));

  const batteryStoredMWh = num(power.batteryStoredMWh);
  const batteryMaxMWh = num(power.batteryMaxMWh) ?? num(power.batteryCapacityMWh);
  const batteryInputMw = num(power.batteryInputMw);
  const batteryOutputMw = num(power.batteryOutputMw);
  const netMw = num(power.netMw);
  // The plugin publishes the breakdown next to netMw (ActionApi power block).
  const generationMw = num(power.generationMw);
  const consumerDrawMw = num(power.consumerDrawMw);
  const batteryChargeMw = num(power.batteryChargeMw) ?? batteryInputMw;

  const batterySectionMissing = !powerRaw || typeof powerRaw !== 'object';
  const batteryBlocks = arr(power.batteries);
  let batteryState: SectionState = batterySectionMissing
    ? 'unread'
    : batteryBlocks.length > 0 || num(power.batteryCapacityMWh) !== null
      ? 'read'
      : 'absent';
  let batteryUnreadReason: string | null = batterySectionMissing
    ? 'profile did not return a power section'
    : null;
  if (str(power.readState) === 'unread') {
    batteryState = 'unread';
    batteryUnreadReason = unreadReasons(power)[0] ?? 'plugin reported the battery read as unread';
  } else if (str(power.readState) === 'no-batteries' || (!batterySectionMissing && batteryBlocks.length === 0 && num(power.batteryCapacityMWh) === null)) {
    batteryState = 'absent';
    batteryUnreadReason = batteryUnreadReason ?? 'no battery on this grid';
  }
  if (batteryState === 'read' && ratio(power.batteryPct) === null && batteryStoredMWh === null) {
    batteryState = 'unread';
    batteryUnreadReason = 'plugin reported no battery percentage';
  }

  const fuelSectionMissing = !fuelRaw || typeof fuelRaw !== 'object';
  const h2TankCount = num(fuel.h2TankCount) ?? h2Tanks.length;
  let h2State: SectionState = fuelSectionMissing
    ? 'unread'
    : h2Tanks.length > 0
      ? 'read'
      : 'absent';
  let h2UnreadReason: string | null = fuelSectionMissing
    ? 'profile did not return a fuel section'
    : null;
  if (str(fuel.readState) === 'unread') {
    h2State = 'unread';
    h2UnreadReason = unreadReasons(fuel)[0] ?? reasonsFor(h2Tanks)[0] ?? 'plugin reported the hydrogen read as unread';
  } else if (str(fuel.readState) === 'no-tanks' || (!fuelSectionMissing && h2Tanks.length === 0)) {
    h2State = 'absent';
    h2UnreadReason = h2UnreadReason ?? 'no hydrogen tank on this grid';
  }
  if (h2State === 'read' && ratio(fuel.h2FillPct) === null && h2Tanks.some((t) => t.readState === 'unread')) {
    h2State = 'unread';
    h2UnreadReason = reasonsFor(h2Tanks)[0] ?? 'plugin could not read the tank fill';
  }

  const radioRange = radio.filter((r) => r.enabled).map((r) => r.radiusM).filter((v): v is number => v !== null && v > 0);
  const laserRange = lasers.map((l) => l.rangeM).filter((v): v is number => v !== null && v > 0);

  const snapshot: PowerSnapshot = {
    gridId,
    name: str(result.name),
    at,
    gameAt: num(result.sampledAt),
    isStatic: typeof result.isStatic === 'boolean' ? result.isStatic : null,
    massKg: num(result.massKg),
    underControl: control.underControl === true,
    controlledBy: str(control.by),

    batteryStoredMWh,
    batteryMaxMWh,
    batteryPct: ratio(power.batteryPct),
    batteryState,
    batteryUnreadReason,
    batteryInputMw,
    batteryOutputMw,
    charge: chargeOf(power.chargeState, batteryInputMw, batteryOutputMw, netMw),
    netMw,
    generationMw,
    consumerDrawMw,
    batteryChargeMw,

    solarActualMw: num(power.solarActualMw),
    solarMaxMw: num(power.solarMaxMw),
    solarEfficiency: ratio(power.solarEfficiency),
    reactorOutputMw: num(power.reactorOutputMw),
    reactorMaxMw: num(power.reactorMaxMw),

    antennaDrawMw: num(power.antennaDrawMw),
    laserDrawMw: num(power.laserDrawMw),
    deviceDrawMw: num(power.deviceDrawMw),

    h2Litres: sum(useTanks.map((t) => t.filledL)),
    h2CapacityLitres: sum(useTanks.map((t) => t.capacityL)),
    h2Pct: ratio(fuel.h2FillPct),
    h2State,
    h2UnreadReason,
    h2TankCount,

    uraniumKg: num(power.uraniumKg),
    uraniumCapacityKg: num(power.uraniumCapacityKg),
    uraniumPct: ratio(power.uraniumPct),

    radioRangeM: radioRange.length ? Math.max(...radioRange) : null,
    laserRangeM: laserRange.length ? Math.max(...laserRange) : null,
    radio,
    lasers,
    reactors,
    tanks,
    solar,

    missing: [],
  };

  // Fill derived percentages only when the sum is complete (never a half sum).
  if (snapshot.batteryPct === null && batteryStoredMWh !== null && batteryMaxMWh !== null && batteryMaxMWh > 0) {
    snapshot.batteryPct = round((batteryStoredMWh / batteryMaxMWh) * 100, 1);
  }
  if (snapshot.h2Pct === null && snapshot.h2Litres !== null && snapshot.h2CapacityLitres !== null && snapshot.h2CapacityLitres > 0) {
    snapshot.h2Pct = round((snapshot.h2Litres / snapshot.h2CapacityLitres) * 100, 1);
  }
  // A value that is still absent after the derivation is an unread, not a 0.
  if (snapshot.h2Pct === null && snapshot.h2State === 'read') {
    snapshot.h2State = 'unread';
    snapshot.h2UnreadReason = snapshot.h2UnreadReason ?? 'plugin reported no hydrogen fill ratio';
  }
  if (snapshot.batteryPct === null && snapshot.batteryState === 'read') {
    snapshot.batteryState = 'unread';
    snapshot.batteryUnreadReason = snapshot.batteryUnreadReason ?? 'plugin reported no battery percentage';
  }
  if (snapshot.uraniumPct === null && snapshot.uraniumKg !== null && snapshot.uraniumCapacityKg !== null && snapshot.uraniumCapacityKg > 0) {
    snapshot.uraniumPct = round((snapshot.uraniumKg / snapshot.uraniumCapacityKg) * 100, 1);
  }
  if (snapshot.solarEfficiency === null && snapshot.solarActualMw !== null && snapshot.solarMaxMw !== null && snapshot.solarMaxMw > 0.0001) {
    snapshot.solarEfficiency = round(snapshot.solarActualMw / snapshot.solarMaxMw, 3);
  }

  for (const [key, label] of [
    ['batteryPct', 'battery'],
    ['solarMaxMw', 'solar'],
    ['h2Pct', 'H2'],
    ['charge', 'charge state'],
  ] as const) {
    const value = snapshot[key];
    if (value === null || value === 'unknown') snapshot.missing.push(label);
  }
  // Reasons are part of the contract: anything missing must say why.
  if (snapshot.batteryState !== 'read' && snapshot.batteryUnreadReason === null) {
    snapshot.batteryUnreadReason = snapshot.batteryState === 'absent' ? 'no battery on this grid' : 'battery state unread';
  }
  if (snapshot.h2State !== 'read' && snapshot.h2UnreadReason === null) {
    snapshot.h2UnreadReason = snapshot.h2State === 'absent' ? 'no hydrogen tank on this grid' : 'hydrogen state unread';
  }
  if ((snapshot.uraniumCapacityKg ?? 0) <= 0 && snapshot.uraniumPct === null && snapshot.reactors.length === 0) {
    // No reactor on the grid: uranium is genuinely not applicable, not missing.
  } else if (snapshot.uraniumPct === null) {
    snapshot.missing.push('uranium');
  }
  return snapshot;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
