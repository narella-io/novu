import { Injectable, Logger } from '@nestjs/common';
import { SendWebhookMessageCommand } from '@novu/application-generic';
import { createHmac } from 'node:crypto';

/**
 * narella: outbound webhooks for COMMUNITY builds.
 *
 * WHY THIS EXISTS. Upstream gates outbound webhooks behind NOVU_ENTERPRISE and delivers
 * them through Svix; the community branch of `outbound-webhooks.module.ts` binds
 * `SendWebhookMessage` to `NoopSendWebhookMessage`, so events are raised and then thrown
 * away. Narella's platform needs `preference.updated` to learn that a user unsubscribed —
 * without it, Django keeps believing it notified people Novu silently dropped.
 *
 * The enterprise packages are not in this fork and Svix is a third-party dependency we do
 * not want for one callback, so this is a direct signed POST instead. Same shape as the
 * `community OrganizationController` patch already carried here.
 *
 * DISABLED UNLESS CONFIGURED. No NOVU_WEBHOOK_URL means this behaves exactly like the
 * no-op it replaces, so an unconfigured deployment is unchanged.
 *
 * SIGNED, because the receiver can disable a user's notifications: an unauthenticated
 * caller who could reach it could silence anybody they could name. HMAC-SHA256 of the raw
 * body under NOVU_WEBHOOK_SECRET, hex, in `Novu-Signature` — the scheme
 * `core/novu_webhook.py` verifies.
 *
 * FIRE AND FORGET. A webhook failure must never fail the notification that triggered it,
 * so every error is logged and swallowed. Narella's daily `reconcile_novu_preferences`
 * pull is the backstop that makes that safe: this path is an optimisation, not the
 * source of truth.
 */
@Injectable()
export class CommunitySendWebhookMessage {
  // Nest's own Logger, not nestjs-pino: pino is not a dependency of either app, and
  // importing it built cleanly in isolation while failing the real image build.
  private readonly logger = new Logger(CommunitySendWebhookMessage.name);

  async execute(command: SendWebhookMessageCommand): Promise<{ eventId: string } | undefined> {
    const url = process.env.NOVU_WEBHOOK_URL;
    if (!url) {
      return undefined;
    }

    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const body = JSON.stringify({
      id: eventId,
      type: command.eventType,
      objectType: command.objectType,
      environmentId: command.environmentId,
      data: command.payload,
    });

    const secret = process.env.NOVU_WEBHOOK_SECRET || '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) {
      headers['Novu-Signature'] = createHmac('sha256', secret).update(body).digest('hex');
    }

    try {
      // Timed out rather than left open: this runs inside notification delivery, and a
      // hung receiver would hold that path open behind it.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.warn(
          `narella: outbound webhook rejected by receiver — status=${response.status} ` +
            `eventType=${command.eventType}`
        );
      }
    } catch (error) {
      this.logger.warn(
        `narella: outbound webhook delivery failed — eventType=${command.eventType}: ${error}`
      );
    }

    return { eventId };
  }
}
