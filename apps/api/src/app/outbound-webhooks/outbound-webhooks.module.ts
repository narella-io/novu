import { DynamicModule, Module } from '@nestjs/common';
import { SendWebhookMessage, SvixProviderService } from '@novu/application-generic';
import { NoopSendWebhookMessage } from '../inbox/usecases/noop-send-webhook-message.usecase';
import { CommunitySendWebhookMessage } from './usecases/community-send-webhook/community-send-webhook.usecase';
import { SharedModule } from '../shared/shared.module';
import { OutboundWebhooksController } from './outbound-webhooks.controller';
import { CreateWebhookPortalUsecase } from './usecases/create-webhook-portal-token/create-webhook-portal.usecase';
import { GetWebhookPortalTokenUsecase } from './usecases/get-webhook-portal-token/get-webhook-portal-token.usecase';

@Module({})
class OutboundWebhooksModuleDefinition {}

const cachedOutboundWebhooksRootModule: Partial<Record<'enterprise' | 'community', DynamicModule>> = {};

export const OutboundWebhooksModule = {
  forRoot(): DynamicModule {
    const isEnterprise = process.env.NOVU_ENTERPRISE === 'true' || process.env.CI_EE_TEST === 'true';
    const cacheKey = isEnterprise ? 'enterprise' : 'community';
    const hit = cachedOutboundWebhooksRootModule[cacheKey];

    if (hit) {
      return hit;
    }

    if (isEnterprise) {
      cachedOutboundWebhooksRootModule.enterprise = {
        module: OutboundWebhooksModuleDefinition,
        imports: [SharedModule],
        controllers: [OutboundWebhooksController],
        providers: [GetWebhookPortalTokenUsecase, CreateWebhookPortalUsecase, SvixProviderService, SendWebhookMessage],
        exports: [SendWebhookMessage],
      };

      return cachedOutboundWebhooksRootModule.enterprise;
    }

    cachedOutboundWebhooksRootModule.community = {
      module: OutboundWebhooksModuleDefinition,
      imports: [SharedModule],
      providers: [
        {
          // narella: community builds deliver outbound webhooks with a direct signed
          // POST instead of dropping them. Falls back to the upstream no-op when
          // NOVU_WEBHOOK_URL is unset, so an unconfigured deployment is unchanged.
          provide: SendWebhookMessage,
          useClass: process.env.NOVU_WEBHOOK_URL ? CommunitySendWebhookMessage : NoopSendWebhookMessage,
        },
      ],
      exports: [SendWebhookMessage],
    };

    return cachedOutboundWebhooksRootModule.community;
  },
};
