#!/usr/bin/env bash
# Acceptance gate for the community MemPalace integration.
#
# The gate grows one task at a time and never drops an earlier check: it always
# runs `npm run check` and the full existing project regression suite, then the
# focused checks of every task completed so far, then the packaged-release and
# CI regression that a push to `main` already has to satisfy.
#
# Covered so far: Tasks 1–8 — provenance, compatibility, transport,
# public resolution, project identity, wake-up, lifecycle, tools, write safety,
# opt-in compact handoff, package cutover, tarball boundaries, real packaged
# install/offline/upgrade acceptance, public documentation, and the strict
# project configuration contract with its trust-gated lazy initialization.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run check
npm test

# --- Task 1: provenance and compatibility baseline -------------------------

node --test --experimental-strip-types test/mempalace/compatibility.test.ts

for required in \
  MIGRATION_PROVENANCE.md \
  integration/compatibility.ts \
  test/mempalace/compatibility.test.ts
do
  [[ -f "$required" ]] || { echo "missing Task 1 artifact: $required" >&2; exit 1; }
done

# --- Task 2: transport, resolution, and project identity --------------------

bash scripts/gate-core.sh
node --test --experimental-strip-types \
  test/mempalace/resolve.test.ts \
  test/mempalace/project-identity.test.ts

for required in \
  integration/mcp-client.ts \
  integration/resolve.ts \
  integration/project-identity.ts \
  test/mempalace/mcp-client.test.ts \
  test/mempalace/mcp-client-integration.test.ts \
  test/mempalace/resolve.test.ts \
  test/mempalace/project-identity.test.ts \
  test/mempalace/fixtures/fake-mempalace-server.mjs \
  test/mempalace/fixtures/fake-mempalace-bin.mjs
do
  [[ -f "$required" ]] || { echo "missing Task 2 artifact: $required" >&2; exit 1; }
done

# --- Task 3: bounded wake-up and lifecycle ---------------------------------

node --test --experimental-strip-types \
  test/mempalace/wakeup.test.ts \
  test/mempalace/lifecycle.test.ts

for required in \
  integration/wakeup.ts \
  integration/lifecycle.ts \
  test/mempalace/wakeup.test.ts \
  test/mempalace/lifecycle.test.ts
do
  [[ -f "$required" ]] || { echo "missing Task 3 artifact: $required" >&2; exit 1; }
done

# --- Task 4: tools, write safety, and opt-in compact handoff ----------------

node --test --experimental-strip-types \
  test/mempalace/safety.test.ts \
  test/mempalace/tools.test.ts \
  test/mempalace/compact-handoff.test.ts \
  test/mempalace/extension.test.ts

for required in \
  integration/safety.ts \
  integration/tools.ts \
  integration/compact-handoff.ts \
  integration/extension.ts \
  integration/index.ts \
  test/mempalace/safety.test.ts \
  test/mempalace/tools.test.ts \
  test/mempalace/compact-handoff.test.ts \
  test/mempalace/extension.test.ts
do
  [[ -f "$required" ]] || { echo "missing Task 4 artifact: $required" >&2; exit 1; }
done

# --- Task 5: package cutover and exact repository/tarball boundaries --------

npm run test:integration
npm run test:package-boundary
npm run check:repository
node --test test/mempalace/public-repository-boundary.test.mjs

for required in \
  extensions/index.ts \
  scripts/check-public-repository.mjs \
  test/mempalace/package-boundary.test.mjs \
  test/mempalace/public-repository-boundary.test.mjs
do
  [[ -f "$required" ]] || { echo "missing Task 5 artifact: $required" >&2; exit 1; }
done

# Migrated code must leave the private source's internal assumptions and any
# absolute developer path behind; neither may reach a community package.
# The two identifiers are assembled rather than written out: this gate ships in
# a public repository, and a guard that spells the private project's name hands
# a searcher exactly what the guard exists to withhold.
private_env="$(printf 'WE_%s_EVAL' 'STACK')"
private_config="$(printf 'ws-%s' 'config')"
if grep -rn -e "$private_env" -e "$private_config" -e '/Users/' integration; then
  echo 'integration/ must not carry the private source assumptions or absolute paths' >&2
  exit 1
fi

# --- Task 6: real packaged provider and lifecycle matrix -------------------

npm run test:packaged

for required in \
  test/mempalace/packaged-acceptance.test.mjs \
  test/mempalace/packaged-real-provider.mjs \
  test/mempalace/fixtures/packaged-provider.ts \
  test/mempalace/fixtures/network-guard.mjs \
  test/mempalace/fixtures/sitecustomize.py
do
  [[ -f "$required" ]] || { echo "missing Task 6 artifact: $required" >&2; exit 1; }
done

# --- Task 7: public documentation and release dossier ----------------------

node --test test/mempalace/public-docs.test.mjs

for required in \
  docs/public/install.md \
  docs/public/configuration.md \
  docs/public/privacy.md \
  docs/public/migration.md \
  docs/public/troubleshooting.md \
  docs/public/compatibility.md
do
  [[ -f "$required" ]] || { echo "missing Task 7 artifact: $required" >&2; exit 1; }
done

# --- Task 8: strict project configuration contract -------------------------

node --test --experimental-strip-types \
  test/mempalace/config.test.ts \
  test/mempalace/extension.test.ts \
  test/mempalace/resolve.test.ts

for required in \
  integration/config.ts \
  test/mempalace/config.test.ts \
  scripts/gate-project-config-pre-attestation.sh
do
  [[ -f "$required" ]] || { echo "missing Task 8 artifact: $required" >&2; exit 1; }
done

# The pre-attestation gate may defer only the two SHA-bound checks below. This
# final gate already runs the full suite and focused checks above; pinning the
# pre-attestation list prevents a future candidate gate from silently widening
# that temporary deferral.
for deferred in \
  test/mempalace/compatibility.test.ts \
  test/mempalace/public-repository-boundary.test.mjs
do
  grep -q "$deferred" scripts/gate-project-config-pre-attestation.sh || {
    echo "the pre-attestation gate no longer defers $deferred to this gate" >&2; exit 1;
  }
done

# The project document is a public, portable contract: it may never require a
# machine-specific location, and it may never be read before the host says the
# project is trusted.
grep -q 'isProjectTrusted' integration/extension.ts || {
  echo 'project configuration must stay gated on the host trust decision' >&2; exit 1;
}

# --- Current release and CI regression -------------------------------------
#
# Renaming the package renames the tarball `npm pack` produces, so the packaged
# release gate and the CI gate are the checks that observe a consumer left
# behind. Both are required by a push to `main`, so the task gate owes them.
# `scripts/gate-ci.sh` needs actionlint and a working Docker daemon.

npm run release:check
bash scripts/gate-ci.sh

printf 'Community MemPalace gate: PASS\n'
