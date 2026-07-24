import { BadRequestException } from '@nestjs/common';
import { assertAllowedSinchSmsRegion, EmailProviderIdEnum, ICredentials, SmsProviderIdEnum } from '@novu/shared';

type ValidateSmtpOutboundTargetModule = typeof import('@novu/shared/dist/cjs/utils/validate-smtp-outbound-target');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertSafeSmtpOutboundTargetSync } =
  require('@novu/shared/utils/validate-smtp-outbound-target') as ValidateSmtpOutboundTargetModule;

export async function validateOutboundIntegrationCredentials(
  providerId: string,
  credentials?: ICredentials
): Promise<void> {
  if (!credentials) {
    return;
  }

  try {
    if (providerId === EmailProviderIdEnum.CustomSMTP) {
      assertSafeSmtpOutboundTargetSync(credentials.host, credentials.port, {
        secure: credentials.secure,
        requireTls: credentials.requireTls,
        ignoreTls: credentials.ignoreTls,
      });
    }

    if (providerId === SmsProviderIdEnum.Sinch) {
      assertAllowedSinchSmsRegion(credentials.region);
    }

    // narella: AWS providers (SES email, SNS SMS) have exactly two auth
    // modes — workload identity (pod IAM role) or a static key pair.
    // Enforce one explicitly so a half-filled form can't silently produce
    // a broken sender.
    const awsProviders: string[] = [EmailProviderIdEnum.SES, SmsProviderIdEnum.SNS];
    if (awsProviders.includes(providerId)) {
      const hasKeys = Boolean(credentials.apiKey) && Boolean(credentials.secretKey);
      const hasPartialKeys = Boolean(credentials.apiKey) !== Boolean(credentials.secretKey);

      if (credentials.useWorkloadIdentity && (credentials.apiKey || credentials.secretKey)) {
        throw new BadRequestException(
          'AWS provider: "Use workload identity" is enabled — leave both access key fields blank (the pod IAM role signs the requests).'
        );
      }

      if (!credentials.useWorkloadIdentity && !hasKeys) {
        throw new BadRequestException(
          hasPartialKeys
            ? 'AWS provider: provide BOTH access key ID and secret access key, or enable "Use workload identity".'
            : 'AWS provider: enable "Use workload identity" (pod IAM role) or provide an access key pair.'
        );
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new BadRequestException(error.message);
    }

    throw error;
  }
}
