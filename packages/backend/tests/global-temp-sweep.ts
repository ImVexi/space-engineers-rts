/**
 * One-off sweep of temp dirs left by runs that were KILLED (2026-11-11).
 *
 * The per-file `afterAll` in `setup-temp-dirs.ts` covers a suite that ends
 * normally. A suite killed mid-run (or an `npm test` interrupted by the
 * iteration cap) leaves its dirs forever, which is how 22 478 accumulated.
 * This global setup deletes `se-rts-test-*` dirs whose mtime is older than
 * 12 h — old enough that nothing running now can own them, so a concurrent
 * suite is never touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STALE_MS = 12 * 60 * 60 * 1000;
const PREFIX = 'se-rts-test-';

export default function setup(): void {
  const base = os.tmpdir();
  const cutoff = Date.now() - STALE_MS;
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(base, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      if (fs.statSync(dir).mtimeMs >= cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      /* best effort: never fail the suite over a leftover dir */
    }
  }
  if (removed > 0) console.log(`[test-temp] removed ${removed} stale ${PREFIX}* dirs`);
}
