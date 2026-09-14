#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Transport/core behavioral gate: real stdio framing, fake incompatibility,
# uncertain-write no-retry, and process-group cleanup.
npm run check
npm run check:repository
npm test

node --test --experimental-strip-types \
  test/mempalace/mcp-client.test.ts \
  test/mempalace/mcp-client-integration.test.ts
