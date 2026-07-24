export interface SESConfig {
  useWorkloadIdentity?: boolean;
  from: string;
  region: string;
  senderName: string;
  accessKeyId: string;
  secretAccessKey: string;
  configurationSetName?: string;
}
