/**
 * One-shot test-API call (TEST SERVER ONLY): runs a single plugin test action
 * through the backend and prints the result JSON. Used for ad-hoc inspection
 * and cleanup between bounded runs.
 *
 *   set -a; . <token-file>; set +a
 *   npx tsx scripts/t4b-cmd.ts '{"action":"list_grids"}'
 *   npx tsx scripts/t4b-cmd.ts '{"action":"delete_grid","entityId":"grid:123"}'
 */
const BASE = process.env.RTS_BASE_URL ?? 'http://127.0.0.1:8762';
const TOKEN = process.env.RTS_TOKEN ?? '';
if (!TOKEN) throw new Error('RTS_TOKEN is not set');
const params = JSON.parse(process.argv[2] ?? '{}');

const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const sent: any = await (
    await fetch(BASE + '/api/test/order', {
      method: 'POST',
      headers,
      body: JSON.stringify({ orderType: 'test', entityId: 'grid:0', params }),
    })
  ).json();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const audit: any = await (await fetch(BASE + '/api/audit?limit=200', { headers })).json();
    const hit = audit.entries.find(
      (e: any) => e.detail?.eventType === 'order_result' && e.detail?.data?.orderId === sent.orderId,
    );
    if (hit) {
      const r = hit.detail.data;
      console.log(JSON.stringify({ ok: r.ok, error: r.error, result: r.result }, null, 1));
      return;
    }
  }
  console.log(JSON.stringify({ ok: false, error: 'no order_result within 40 s' }));
})();
