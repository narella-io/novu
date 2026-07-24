import { PageMeta } from '@/components/page-meta';
import { DashboardLayout } from '@/components/dashboard-layout';

const MCP_URL = 'https://novu-mcp.narella.io/mcp';

function Snippet({ children }: { children: string }) {
  return (
    <pre className="border-stroke-soft bg-background overflow-x-auto rounded-lg border p-3 text-xs">
      <code>{children}</code>
    </pre>
  );
}

export function McpServerPage() {
  return (
    <>
      <PageMeta title="MCP Server" />
      <DashboardLayout>
        <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
          <div>
            <h1 className="text-foreground-950 text-xl font-semibold">MCP Server</h1>
            <p className="text-foreground-600 mt-1 text-sm">
              AI clients (Claude Code, claude.ai, Cursor, ...) can author and manage the workflows in this Novu
              instance through our self-hosted MCP server. Auth is the standard remote-MCP OAuth flow: your client
              registers itself, you approve via Google sign-in (allowlisted admins only), and tokens never leave our
              infrastructure.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-foreground-950 text-sm font-semibold">Endpoint</h2>
            <Snippet>{MCP_URL}</Snippet>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-foreground-950 text-sm font-semibold">Claude Code</h2>
            <Snippet>{`claude mcp add --transport http narella-novu ${MCP_URL}`}</Snippet>
            <p className="text-foreground-600 text-xs">
              On first use Claude Code opens the browser for the Google consent; afterwards tools like{' '}
              <code>list_workflows</code>, <code>create_workflow</code>, <code>trigger_workflow</code> and{' '}
              <code>list_integrations</code> are available in any session.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-foreground-950 text-sm font-semibold">claude.ai (web/desktop)</h2>
            <p className="text-foreground-600 text-xs">
              Settings → Connectors → Add custom connector → paste the endpoint URL. The OAuth dance (dynamic client
              registration + PKCE) is automatic.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-foreground-950 text-sm font-semibold">Cursor / other MCP clients</h2>
            <Snippet>{`{
  "mcpServers": {
    "narella-novu": {
      "url": "${MCP_URL}"
    }
  }
}`}</Snippet>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-foreground-950 text-sm font-semibold">Available tools</h2>
            <ul className="text-foreground-600 list-inside list-disc text-sm">
              <li>
                <code>list_workflows</code> / <code>get_workflow</code> — inspect existing flows
              </li>
              <li>
                <code>create_workflow</code> / <code>update_workflow</code> / <code>delete_workflow</code> — full
                authoring (steps, delays, email content, tags)
              </li>
              <li>
                <code>trigger_workflow</code> — fire a test or real send at a subscriber
              </li>
              <li>
                <code>list_integrations</code> — which channels are actually deliverable (active providers) before
                authoring steps
              </li>
            </ul>
          </div>
        </div>
      </DashboardLayout>
    </>
  );
}
