#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Transport/core behavioral gate: real stdio framing, fake incompatibility,
# uncertain-write no-retry, and process-group cleanup.
pre_attestation=false
if [[ "${1:-}" == '--pre-attestation' && $# -eq 1 ]]; then
  pre_attestation=true
elif [[ $# -ne 0 ]]; then
  printf 'usage: %s [--pre-attestation]\n' "$0" >&2
  exit 2
fi

if [[ "$pre_attestation" == true ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
    printf 'pre-attestation requires a clean committed tree\n' >&2
    exit 1
  fi
  candidate_sha="$(node --input-type=module -e "import { packCandidateDigest } from './test/mempalace/matrix-evidence.mjs'; process.stdout.write(packCandidateDigest(process.cwd()));")"
  source_commit="$(git rev-parse HEAD)"
fi

npm run check
npm run check:repository
if [[ "$pre_attestation" == true ]]; then
  EXPECTED_CANDIDATE_SHA256="$candidate_sha" EXPECTED_SOURCE_COMMIT="$source_commit" npm test
else
  npm test
fi

if [[ "$pre_attestation" == true ]]; then
  env -u EXPECTED_CANDIDATE_SHA256 -u EXPECTED_SOURCE_COMMIT node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { assertMatrixEvidenceBound } from './test/mempalace/matrix-evidence.mjs';

const evidence = JSON.parse(readFileSync('.github/verification/task-967-matrix.json', 'utf8'));
try {
  assertMatrixEvidenceBound(evidence, { root: process.cwd(), env: {} });
} catch (error) {
  if (String(error).includes('matrix candidate differs')) process.exit(0);
  process.stderr.write(`unanchored matrix validation failed for an unexpected reason: ${String(error)}\n`);
  process.exit(1);
}
process.stderr.write('unanchored matrix validation unexpectedly accepted stale evidence\n');
process.exit(1);
NODE
fi

node --test --experimental-strip-types \
  test/mempalace/mcp-client.test.ts \
  test/mempalace/mcp-client-integration.test.ts
