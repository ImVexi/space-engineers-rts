import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = createRuntime({ config });
  const port = await runtime.listen();

  // eslint-disable-next-line no-console
  console.log(
    `[se-rts] listening on http://${config.bind}:${port} ` +
      `(auth=${config.token ? 'bearer' : 'off'}, killSwitch=${runtime.store.isKillSwitchOn()})`,
  );
  // eslint-disable-next-line no-console
  console.log(`[se-rts] flags ${JSON.stringify(runtime.store.getFlags())}`);
  if (config.owner.steamId === '' && (process.env.RTS_OWNER_STEAM_IDS ?? '').trim() === '') {
    // eslint-disable-next-line no-console
    console.warn(
      '[se-rts] WARNING: no owner Steam id configured. Set RTS_OWNER_STEAM_IDS ' +
        '(comma-separated) or plugin.json ownerSteamIds; until then every grid is ' +
        'treated as not yours and nothing is automated.',
    );
  }
  runtime.startLoops();

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[se-rts] ${signal} received, shutting down`);
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[se-rts] fatal:', err);
  process.exit(1);
});
