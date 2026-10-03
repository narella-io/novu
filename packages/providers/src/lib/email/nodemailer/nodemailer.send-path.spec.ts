/**
 * narella: interface guard for the nodemailer send path.
 *
 * nodemailer.provider.spec.ts is `describe.skip` upstream and mocks createTransport,
 * so nothing in this package exercised the REAL library. This file pins exactly the
 * nodemailer surface our providers call, with no mock of nodemailer itself:
 *
 *   - nodemailer.provider.ts      createTransport(SMTPTransport.Options) + sendMail + close
 *                                 with the SendMailOptions shape built by createMailData,
 *                                 including the DKIM.SingleKeyOptions shape
 *   - ses.provider.ts (narella    createTransport({ SES: { sesClient, SendEmailCommand } })
 *     SES workload-identity path) + sendMail with `ses.ConfigurationSetName`
 *   - outlook365.provider.ts      createTransport(options) + sendMail
 *   - every provider              the CJS build compiled by tsc does
 *                                 `__importDefault(require('nodemailer')).default.createTransport`
 *
 * Written for the 9.0.1 -> 10.x major bump (TypeScript rewrite, ESM + CJS builds).
 * It must pass on both versions.
 */
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import nodemailer, { SendMailOptions, Transporter } from 'nodemailer';
import { describe, expect, test, vi } from 'vitest';

const mail: SendMailOptions = {
  from: { address: 'sender@narella.io', name: 'Narella' },
  to: ['a@example.com', 'b@example.com'],
  cc: ['c@example.com'],
  bcc: ['d@example.com'],
  replyTo: 'reply@narella.io',
  subject: 'contract subject',
  html: '<p>hello <b>html</b></p>',
  text: 'hello text',
  alternatives: [{ contentType: 'text/x-web-markdown', content: '**hello md**' }],
  headers: { 'X-Narella-Test': 'yes' },
  attachments: [
    {
      filename: 'note.txt',
      content: Buffer.from('attachment body'),
      contentType: 'text/plain',
      cid: undefined,
      contentDisposition: 'attachment',
    },
    {
      filename: 'logo.png',
      content: Buffer.from('png-bytes'),
      contentType: 'image/png',
      cid: 'logo@narella',
      contentDisposition: 'inline',
    },
  ],
};

describe('nodemailer send path (real library, no mock)', () => {
  test('jsonTransport: sendMail accepts the createMailData shape and returns a messageId', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const info = await transport.sendMail(mail);

    expect(typeof info.messageId).toBe('string');
    expect(info.messageId).toMatch(/^<.+@.+>$/);
    expect(info.envelope.from).toBe('sender@narella.io');
    expect(info.envelope.to).toEqual(
      expect.arrayContaining(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'])
    );

    const json = JSON.parse(info.message as unknown as string);
    expect(json.subject).toBe('contract subject');
    expect(json.from).toEqual({ address: 'sender@narella.io', name: 'Narella' });
    expect(json.headers).toEqual({ 'X-Narella-Test': 'yes' });
    expect(json.attachments).toHaveLength(2);
    transport.close();
  });

  test('streamTransport: raw MIME carries headers, alternatives, attachments and a DKIM signature', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    // Same shape nodemailer.provider.ts forwards as `dkim` (DKIM.SingleKeyOptions).
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
      dkim: { domainName: 'narella.io', keySelector: 'novu', privateKey },
    });
    const info = await transport.sendMail(mail);
    const raw = (info.message as Buffer).toString('utf8');

    // The header is folded across lines, so match its parts separately.
    expect(raw).toMatch(/^DKIM-Signature: v=1; a=rsa-sha256;/m);
    expect(raw).toMatch(/\bd=narella\.io;/);
    expect(raw).toMatch(/\bs=novu;/);
    expect(raw).toContain('Subject: contract subject');
    expect(raw).toContain('X-Narella-Test: yes');
    expect(raw).toContain('Reply-To: reply@narella.io');
    expect(raw).toContain('text/x-web-markdown');
    expect(raw).toContain('Content-Disposition: attachment; filename=note.txt');
    expect(raw).toContain('Content-ID: <logo@narella>');
    transport.close();
  });

  test('SMTP transport: accepts the buildTransportOptions shape and exposes close()', () => {
    // Exactly the keys NodemailerProvider.buildTransportOptions returns; no connection is opened.
    const transport = nodemailer.createTransport({
      name: 'smtp.example.com',
      host: '127.0.0.1',
      port: 2525,
      secure: false,
      connectionTimeout: 10000,
      socketTimeout: 10000,
      auth: { user: 'u', pass: 'p' },
      dkim: undefined,
      ignoreTLS: false,
      requireTLS: true,
      tls: { servername: 'smtp.example.com' },
    });

    expect(typeof transport.sendMail).toBe('function');
    expect(typeof transport.close).toBe('function');
    expect(transport.transporter.name).toBe('SMTP');
    transport.close();
  });

  test('SES transport (narella SES-IRSA path): sends one SendEmailCommand with the raw message and configuration set', async () => {
    const send = vi.fn(async (_command: unknown) => ({ MessageId: '0100018f-ses-id' }));
    const sesClient = { config: { region: async () => 'us-east-2' }, send };
    const transport = nodemailer.createTransport({ SES: { sesClient, SendEmailCommand } } as any) as unknown as Transporter;

    const info = await transport.sendMail({
      ...mail,
      ses: { ConfigurationSetName: 'narella-events' },
    } as SendMailOptions);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as SendEmailCommand;
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input.ConfigurationSetName).toBe('narella-events');
    const raw = Buffer.from(command.input.Content?.Raw?.Data as Uint8Array).toString('utf8');
    expect(raw).toContain('Subject: contract subject');
    expect(raw).toContain('X-Narella-Test: yes');
    // ses.provider.ts returns info.messageId as the provider id.
    expect(info.messageId).toBe('<0100018f-ses-id@us-east-2.amazonses.com>');
  });

  test('CJS interop: the tsc CJS build resolves createTransport through __importDefault', () => {
    const require = createRequire(__filename);
    const cjs = require('nodemailer');
    // tsc (esModuleInterop) emits: (mod && mod.__esModule) ? mod : { default: mod }
    const interop = cjs && cjs.__esModule ? cjs : { default: cjs };

    expect(typeof interop.default.createTransport).toBe('function');
    const transport = interop.default.createTransport({ jsonTransport: true });
    expect(typeof transport.sendMail).toBe('function');
  });
});
