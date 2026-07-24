// Narella Novu MCP server — workflow authoring tools for AI clients (Claude
// Code, claude.ai, Cursor, ...) against the SELF-HOSTED Novu api. Nothing
// here talks to Novu's cloud.
//
// Auth is the standard remote-MCP flow (MCP auth spec): OAuth 2.1 with PKCE
// + dynamic client registration, served by this process; the user-facing
// authorize step is Google sign-in (the narella-ops internal client) with an
// email allowlist. Tokens are in-memory — a restart just re-prompts the
// (two) admins to reconnect.

import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

const PORT = Number(process.env.PORT || 3006);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const NOVU_API_URL = (process.env.NOVU_API_URL || '').replace(/\/$/, '');
const NOVU_API_KEY = process.env.NOVU_API_KEY || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const ALLOWED_EMAILS = (process.env.GOOGLE_OAUTH_ALLOWED_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const ACCESS_TOKEN_TTL_S = 8 * 60 * 60;
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

const rand = () => crypto.randomBytes(32).toString('base64url');

// ---------------------------------------------------------------------------
// In-memory OAuth state
// ---------------------------------------------------------------------------

const clients = new Map(); // client_id -> OAuthClientInformationFull
const pendingAuths = new Map(); // googleState -> {clientId, redirectUri, codeChallenge, clientState, createdAt}
const codes = new Map(); // code -> {clientId, codeChallenge, redirectUri, email, createdAt}
const accessTokens = new Map(); // token -> {clientId, email, expiresAt(ms)}
const refreshTokens = new Map(); // token -> {clientId, email, expiresAt(ms)}

const provider = {
  clientsStore: {
    getClient: (clientId) => clients.get(clientId),
    registerClient: (client) => {
      const full = {
        ...client,
        client_id: rand(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
      clients.set(full.client_id, full);
      return full;
    },
  },

  async authorize(client, params, res) {
    const googleState = rand();
    pendingAuths.set(googleState, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state,
      createdAt: Date.now(),
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${PUBLIC_URL}/oauth/google/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', googleState);
    url.searchParams.set('prompt', 'select_account');
    res.redirect(url.toString());
  },

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const entry = codes.get(authorizationCode);
    if (!entry) throw new Error('Unknown authorization code');
    return entry.codeChallenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode) {
    const entry = codes.get(authorizationCode);
    codes.delete(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) throw new Error('Invalid authorization code');
    if (Date.now() - entry.createdAt > AUTH_CODE_TTL_MS) throw new Error('Authorization code expired');

    const accessToken = rand();
    const refreshToken = rand();
    accessTokens.set(accessToken, {
      clientId: client.client_id,
      email: entry.email,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000,
    });
    refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      email: entry.email,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_S * 1000,
    });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
    };
  },

  async exchangeRefreshToken(client, refreshToken) {
    const entry = refreshTokens.get(refreshToken);
    if (!entry || entry.clientId !== client.client_id || Date.now() > entry.expiresAt) {
      refreshTokens.delete(refreshToken);
      throw new Error('Invalid refresh token');
    }
    refreshTokens.delete(refreshToken);
    const accessToken = rand();
    const newRefresh = rand();
    accessTokens.set(accessToken, {
      clientId: client.client_id,
      email: entry.email,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000,
    });
    refreshTokens.set(newRefresh, {
      clientId: client.client_id,
      email: entry.email,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_S * 1000,
    });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: newRefresh,
    };
  },

  async verifyAccessToken(token) {
    const entry = accessTokens.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      accessTokens.delete(token);
      throw new Error('Invalid or expired token');
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: [],
      expiresAt: Math.floor(entry.expiresAt / 1000),
      extra: { email: entry.email },
    };
  },
};

// ---------------------------------------------------------------------------
// Novu API helpers (self-hosted only)
// ---------------------------------------------------------------------------

async function novu(method, path, body) {
  const r = await fetch(`${NOVU_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `ApiKey ${NOVU_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!r.ok) {
    throw new Error(`Novu API ${method} ${path} -> ${r.status}: ${JSON.stringify(parsed).slice(0, 800)}`);
  }
  return parsed;
}

const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function buildMcpServer() {
  const server = new McpServer({ name: 'narella-novu', version: '1.0.0' });

  server.tool(
    'list_workflows',
    'List notification workflows on the self-hosted Narella Novu (id, name, status, tags).',
    { query: z.string().optional().describe('Optional name filter') },
    async ({ query }) => {
      const qs = query ? `?query=${encodeURIComponent(query)}` : '';
      return asText(await novu('GET', `/v2/workflows${qs}`));
    }
  );

  server.tool(
    'get_workflow',
    'Fetch a workflow definition (steps, delays, email bodies) by its workflow id/slug.',
    { workflowId: z.string().describe('Workflow identifier, e.g. waitlist-nurture') },
    async ({ workflowId }) => asText(await novu('GET', `/v2/workflows/${encodeURIComponent(workflowId)}`))
  );

  server.tool(
    'create_workflow',
    'Create a workflow. `definition` is the Novu v2 workflow DTO: {name, workflowId, description?, tags?, steps: [{name, type: in_app|email|delay|digest|sms|push|chat, controlValues: {...}}]}. Email controlValues: {subject, body(Maily JSON or simple)}. Delay controlValues: {amount, unit: seconds|minutes|hours|days}.',
    { definition: z.record(z.unknown()).describe('Full v2 workflow DTO') },
    async ({ definition }) => asText(await novu('POST', '/v2/workflows', definition))
  );

  server.tool(
    'update_workflow',
    'Update an existing workflow with a full v2 workflow DTO (PUT semantics — send the complete definition).',
    {
      workflowId: z.string(),
      definition: z.record(z.unknown()).describe('Full v2 workflow DTO'),
    },
    async ({ workflowId, definition }) =>
      asText(await novu('PUT', `/v2/workflows/${encodeURIComponent(workflowId)}`, definition))
  );

  server.tool(
    'delete_workflow',
    'Delete a workflow by id/slug.',
    { workflowId: z.string() },
    async ({ workflowId }) => {
      await novu('DELETE', `/v2/workflows/${encodeURIComponent(workflowId)}`);
      return asText({ deleted: workflowId });
    }
  );

  server.tool(
    'list_integrations',
    'List configured channel integrations (provider, channel, active, primary). Workflow steps can only deliver on channels with an ACTIVE integration — check this before authoring steps (e.g. email requires the SES integration to be active; in_app requires the In-App integration).',
    {},
    async () => {
      const result = await novu('GET', '/v1/integrations');
      const rows = (result.data || []).map((integration) => ({
        providerId: integration.providerId,
        channel: integration.channel,
        active: integration.active,
        primary: integration.primary,
        name: integration.name,
        environmentId: integration._environmentId,
      }));
      return asText({
        integrations: rows,
        activeChannels: [...new Set(rows.filter((r) => r.active).map((r) => r.channel))],
      });
    }
  );

  server.tool(
    'trigger_workflow',
    'Trigger a workflow for a subscriber (test or real send).',
    {
      workflowId: z.string(),
      subscriberId: z.string().describe('Subscriber id, e.g. waitlist-1'),
      email: z.string().optional().describe('Subscriber email (upserted on trigger)'),
      payload: z.record(z.unknown()).optional(),
    },
    async ({ workflowId, subscriberId, email, payload }) =>
      asText(
        await novu('POST', '/v1/events/trigger', {
          name: workflowId,
          to: email ? { subscriberId, email } : { subscriberId },
          payload: payload || {},
        })
      )
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(PUBLIC_URL),
    resourceName: 'Narella Novu MCP',
    scopesSupported: [],
  })
);

// Google half of the authorize step (outside the SDK router).
app.get('/oauth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const pending = typeof state === 'string' ? pendingAuths.get(state) : undefined;
  if (!pending || typeof code !== 'string') {
    res.status(400).send('Invalid OAuth state');
    return;
  }
  pendingAuths.delete(state);

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_URL}/oauth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(`Google token exchange failed: ${JSON.stringify(tokens)}`);

    const userinfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userinfo = await userinfoResponse.json();
    const email = (userinfo.email || '').toLowerCase();

    const redirect = new URL(pending.redirectUri);
    if (!email || !ALLOWED_EMAILS.includes(email)) {
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('error_description', `${email || 'account'} is not allowlisted`);
      if (pending.clientState) redirect.searchParams.set('state', pending.clientState);
      res.redirect(redirect.toString());
      return;
    }

    const authCode = rand();
    codes.set(authCode, {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      email,
      createdAt: Date.now(),
    });
    redirect.searchParams.set('code', authCode);
    if (pending.clientState) redirect.searchParams.set('state', pending.clientState);
    res.redirect(redirect.toString());
  } catch (error) {
    res.status(500).send(`OAuth error: ${error instanceof Error ? error.message : 'unknown'}`);
  }
});

// Stateless streamable-HTTP MCP endpoint: fresh server+transport per request.
const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: `${PUBLIC_URL}/.well-known/oauth-protected-resource`,
});

app.post('/mcp', bearer, async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed — stateless server, POST only' },
    id: null,
  });
};
app.get('/mcp', bearer, methodNotAllowed);
app.delete('/mcp', bearer, methodNotAllowed);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, novuConfigured: Boolean(NOVU_API_URL && NOVU_API_KEY) });
});

// Hourly sweep of expired in-memory state.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuths) if (now - v.createdAt > AUTH_CODE_TTL_MS) pendingAuths.delete(k);
  for (const [k, v] of codes) if (now - v.createdAt > AUTH_CODE_TTL_MS) codes.delete(k);
  for (const [k, v] of accessTokens) if (now > v.expiresAt) accessTokens.delete(k);
  for (const [k, v] of refreshTokens) if (now > v.expiresAt) refreshTokens.delete(k);
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`narella-novu-mcp listening on :${PORT} (public: ${PUBLIC_URL})`);
});
