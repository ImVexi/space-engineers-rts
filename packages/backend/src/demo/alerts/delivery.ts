/**
 * T68 delivery.
 *
 * Every alert is written to the audit log, always. Discord is optional:
 * `alerts.discordWebhook` must be set (default empty = disabled). One message
 * per alert; non-critical alerts wait up to `batchMs` (5 s) so a burst from
 * one evaluation becomes a short burst of messages rather than a stream.
 * Critical alerts bypass the queue and are sent on the spot.
 *
 * Sending can never throw into the poller: every path is wrapped, failures are
 * audited as `alert_delivery_error` and logged, and the queue keeps going.
 */
import type { Alert, Store } from '../../store.js';
import type { AlertsSettings } from './settings.js';

export type DeliveryVariant = 'opened' | 'updated' | 'resolved';

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
  }>;
}

export interface AlertDeliveryDeps {
  store: Store;
  clock: () => number;
  settings: () => AlertsSettings;
  fetchImpl?: FetchLike;
  logger?: (message: string) => void;
}

interface PendingMessage {
  alert: Alert;
  variant: DeliveryVariant;
  dueAt: number;
}

/** Discord hard limit is 2000 chars; keep a margin for the header. */
const MAX_CONTENT = 1_900;

export function discordContent(alert: Alert, variant: DeliveryVariant): string {
  const head =
    variant === 'resolved'
      ? `[RESOLVED] ${alert.kind} — ${alert.subjectType} ${alert.subjectId}`
      : `[${alert.severity.toUpperCase()}] ${alert.kind} — ${alert.subjectType} ${alert.subjectId}`;
  const actions = alert.actions
    .slice(0, 6)
    .map((a) => `• ${a.label}: ${a.method} ${a.endpoint}`)
    .join('\n');
  const body = [head, alert.message, actions ? `Actions:\n${actions}` : '']
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return body.length > MAX_CONTENT ? `${body.slice(0, MAX_CONTENT - 1)}…` : body;
}

export class AlertDelivery {
  private readonly queue: PendingMessage[] = [];
  private readonly log: (message: string) => void;
  private lastError: string | null = null;

  constructor(private readonly deps: AlertDeliveryDeps) {
    this.log = deps.logger ?? ((message) => console.warn(`[alerts] ${message}`));
  }

  /** Number of non-critical messages waiting for the batch window. */
  get pending(): number {
    return this.queue.length;
  }

  get lastDeliveryError(): string | null {
    return this.lastError;
  }

  /**
   * `deliver(alerts)` — audit always, Discord when configured.
   * Returns the channels that accepted each alert (for the evaluate response).
   */
  async deliver(
    entries: { alert: Alert; variant: DeliveryVariant }[],
    now = this.deps.clock(),
  ): Promise<{ alertId: string; channels: string[]; mode: 'immediate' | 'batched' | 'disabled' }[]> {
    const settings = this.deps.settings();
    const webhook = settings.discordWebhook;
    const results: { alertId: string; channels: string[]; mode: 'immediate' | 'batched' | 'disabled' }[] = [];

    for (const { alert, variant } of entries) {
      const critical = alert.severity === 'critical' && variant !== 'resolved';
      const mode = !webhook ? 'disabled' : critical ? 'immediate' : 'batched';
      const channels = ['audit'];
      if (webhook) channels.push('discord');

      try {
        this.deps.store.audit({
          actor: 'alerts',
          action: variant === 'resolved' ? 'alert_resolved_delivered' : 'alert_delivered',
          subject: alert.id,
          detail: {
            kind: alert.kind,
            severity: alert.severity,
            subjectType: alert.subjectType,
            subjectId: alert.subjectId,
            variant,
            channels,
            deliveryMode: mode,
            count: alert.count,
          },
          at: now,
        });
      } catch (err) {
        // Audit failing must not stop the alert from being queued.
        this.fail(alert, `audit write failed: ${errText(err)}`, now);
      }

      if (!webhook) {
        results.push({ alertId: alert.id, channels, mode });
        continue;
      }

      try {
        if (critical) {
          await this.send(alert, variant, now);
        } else {
          this.queue.push({ alert, variant, dueAt: now + Math.max(0, settings.batchMs) });
        }
      } catch (err) {
        // `send` already guards itself; this is belt and braces.
        this.fail(alert, errText(err), now);
      }
      results.push({ alertId: alert.id, channels, mode });
    }
    return results;
  }

  /** Send every queued message whose batch window has elapsed. */
  async flushDue(now = this.deps.clock()): Promise<number> {
    const due = this.queue.filter((item) => item.dueAt <= now);
    if (due.length === 0) return 0;
    for (const item of due) {
      const index = this.queue.indexOf(item);
      if (index >= 0) this.queue.splice(index, 1);
      try {
        await this.send(item.alert, item.variant, now);
      } catch (err) {
        this.fail(item.alert, errText(err), now);
      }
    }
    return due.length;
  }

  private async send(alert: Alert, variant: DeliveryVariant, now: number): Promise<void> {
    const settings = this.deps.settings();
    const webhook = settings.discordWebhook;
    if (!webhook) return;
    const fetchImpl = this.deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!fetchImpl) {
      this.fail(alert, 'no fetch implementation available', now);
      return;
    }
    try {
      const res = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: discordContent(alert, variant),
          // Plain text only: alerts carry grid names, never mentions.
          allowed_mentions: { parse: [] },
        }),
      });
      if (!res.ok) this.fail(alert, `webhook returned HTTP ${res.status}`, now);
    } catch (err) {
      this.fail(alert, errText(err), now);
    }
  }

  private fail(alert: Alert, error: string, now: number): void {
    this.lastError = error;
    try {
      this.deps.store.audit({
        actor: 'alerts',
        action: 'alert_delivery_error',
        subject: alert.id,
        detail: { kind: alert.kind, subjectId: alert.subjectId, error },
        at: now,
      });
    } catch {
      /* nothing else to do: logging must not throw into the poller */
    }
    this.log(`delivery failed for ${alert.id}: ${error}`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
