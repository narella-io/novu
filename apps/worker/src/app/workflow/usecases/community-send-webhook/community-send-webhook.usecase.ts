import { Injectable } from '@nestjs/common';
import { SendWebhookMessageCommand } from '@novu/application-generic';
import { createHmac } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';

/**
 * narella: outbound webhooks for COMMUNITY builds.
 *
 * WORKER COPY of the api usecase, kept byte-identical apart from this note. The two
 * apps build into separate images from separate Dockerfiles and share nothing outside
 * `libs/`; putting it in `libs/` to deduplicate would mean patching an upstream package
 * that every future rebase has to carry. Two small copies rebase more cleanly than one
 * shared edit in a file upstream also touches.
 *
 * WHY THIS EXISTS. Upstream gates outbound webhooks behind NOVU_ENTERPRISE and delivers
 * them through Svix; the worker binds `SendWebhookMessage` to its own
 * `NoopSendWebhookMessage`, so events are raised and then thrown away. The worker owns
 * DELIVERY events — message.sent / message.failed / message.delivered. The api patch
 * covers `preference.updated` (unsubscribes); this one is what makes a FAILED brief
 * notification visible at all. Without it Narella cannot tell a delivered email from a
 * bounced one.
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
  constructor(private logger: PinoLogger) {
    this.logger.setContext(this.constructor.name);
  }

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
          { status: response.status, eventType: command.eventType },
          'narella: outbound webhook rejected by receiver'
        );
      }
    } catch (error) {
      this.logger.warn(
        { error, eventType: command.eventType },
        'narella: outbound webhook delivery failed'
      );
    }

    return { eventId };
  }
}
