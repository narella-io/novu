# Narella fork of Novu

Deployment branch: `narella/v3.18.0` (default). Never merge upstream branches;
upgrades are cherry-picks onto a new tag branch:

    git fetch upstream --tags          # upstream = novuhq/novu
    git checkout -b narella/vX.Y.Z vX.Y.Z
    git cherry-pick <first-narella-commit>..narella/v3.18.0
    # resolve, build via scripts/narella-build-and-push.sh vX.Y.Z-narella.1,
    # bump base/novu/values.yaml images.tag in the argocd repo

## The patch series (git log vX.Y.Z..narella/<branch>, `narella:` prefixed)

1. **De-brand** — org-settings usecases: removeNovuBranding defaults true, 402 paywall removed
2. **Google OAuth (api)** — passport strategy + /v1/auth/google routes (AuthGuard on the
   initiation route — Nest middleware string paths do NOT match the /v1 global prefix),
   GOOGLE_OAUTH_ALLOWED_EMAILS allowlist, FRONT_BASE_URL-first callback redirect
   (bundled .env defaults DASHBOARD_URL to Novu's cloud — token must never go there),
   auto-create org (DEFAULT_ORGANIZATION_NAME) / auto-join on login BEFORE token mint
3. **Google OAuth (dashboard)** — Google-only SignIn, ?token= ingest with HARD reload
   (SPA navigate races the initialized auth state), org-list page self-heals no-org tokens
4. **Telemetry** — HubSpot identify no-op (hardcoded portal IDs upstream), Nx Cloud runner
   removed; all other analytics stay env-gated-off in the chart
5. **UI** — auth-page upsell/logo walls removed, user-menu cloud items removed, Google
   avatar from JWT profilePicture, org logo (branding.logo, Narella mark fallback),
   Developer → MCP Server page (env-scoped route!)
6. **De-restriction** — feature-tiers-constants remaps every tier to UNLIMITED at load
   (kills every 402 plan gate api+dashboard); CE hides translations/agents (EE-only
   backends). Upstream e2e tier tests fail by design.
7. **narella-mcp/** — standalone MCP server (workflow authoring for AI clients), see its
   sources; deployed from its own Dockerfile as narella/novu-mcp

## Build

    pnpm install --ignore-scripts    # once; NODE_OPTIONS=--max-old-space-size=8192 if OOM
    ./scripts/narella-build-and-push.sh v3.18.0-narella.N

api+dashboard build from the fork; worker/ws mirror upstream (no patches touch them);
narella-mcp builds separately from narella-mcp/Dockerfile.
