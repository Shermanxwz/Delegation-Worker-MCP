#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${DWMCP_NODE_PATH:-}" ]]; then
  exec "$DWMCP_NODE_PATH" "$root/mcp/server.mjs"
fi
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=20?0:1)' >/dev/null 2>&1; then
  exec node "$root/mcp/server.mjs"
fi
echo "delegation-worker-mcp: Node.js 20+ is required" >&2
exit 127
