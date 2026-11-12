import { loadConfig } from '../src/config.js';
import { DetectorService } from '../src/detector/saveDetector.js';

/**
 * Read-only CLI: scan a synced save copy for [HERMES-TEST] handoff grids.
 *   npx tsx packages/backend/scripts/detect.ts [--sbs path] [--sbc path]
 * Never writes to the save.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const detector = new DetectorService({
    sbsPath: arg('--sbs') ?? config.detector.sbsPath,
    sbcPath: arg('--sbc') ?? config.detector.sbcPath,
    owner: config.owner,
  });
  const report = await detector.refresh();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[detect] failed:', err);
  process.exit(1);
});
