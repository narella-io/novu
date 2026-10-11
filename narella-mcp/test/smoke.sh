#!/usr/bin/env bash
# narella-mcp HTTP smoke: healthz, OAuth metadata, dynamic client registration, unauthenticated /mcp -> 401
dir="${1:-$(cd "$(dirname "$0")/.." && pwd)}"; port="${2:-3916}"
cd "$dir" || exit 1
PORT=$port PUBLIC_URL=http://localhost:$port NOVU_API_URL=http://localhost:1 NOVU_API_KEY=x GOOGLE_OAUTH_CLIENT_ID=x GOOGLE_OAUTH_CLIENT_SECRET=x GOOGLE_OAUTH_ALLOWED_EMAILS=a@b.c node src/index.js > "$(mktemp)" 2>&1 &
pid=$!
sleep 2
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: got $2 want $3"; fi; }
chk healthz "$(curl -s -o /dev/null -w '%{http_code}' localhost:$port/healthz)" 200
chk as-meta "$(curl -s -o /dev/null -w '%{http_code}' localhost:$port/.well-known/oauth-authorization-server)" 200
chk pr-meta "$(curl -s -o /dev/null -w '%{http_code}' localhost:$port/.well-known/oauth-protected-resource)" 200
chk register "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"redirect_uris":["http://localhost:9/cb"],"client_name":"t","token_endpoint_auth_method":"none"}' localhost:$port/register)" 201
chk mcp-noauth "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' localhost:$port/mcp)" 401
kill $pid; wait $pid 2>/dev/null
echo "pass=$pass fail=$fail"; [ "$fail" = 0 ]
