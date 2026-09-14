#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

command -v actionlint >/dev/null || { echo 'actionlint is required' >&2; exit 1; }
actionlint .github/workflows/ci.yml .github/workflows/release.yml
npm run check:repository

node - <<'NODE'
const fs = require('node:fs');
const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const release = fs.readFileSync('.github/workflows/release.yml', 'utf8');
const gate = fs.readFileSync('scripts/gate-ci.sh', 'utf8');

// Rules that hold for every workflow in the repository. A new workflow file
// used to escape this gate entirely, which meant the weakest workflow set the
// repository's real security posture while this one enforced the strongest.
const WORKFLOWS = [['ci.yml', workflow], ['release.yml', release]];
for (const [name, source] of WORKFLOWS) {
  for (const line of source.split('\n').filter((line) => /^\s*runs-on:/.test(line))) {
    if (/self-hosted/.test(line)) {
      throw new Error(`${name} declares a self-hosted runner while pull requests are validated: ${line.trim()}`);
    }
  }
  for (const line of source.split('\n').filter((line) => line.includes('uses:'))) {
    if (!/uses: [^@]+@[a-f0-9]{40}(?:\s|$)/.test(line)) throw new Error(`action is not SHA-pinned in ${name}: ${line.trim()}`);
  }
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.includes('uses: actions/checkout@')) continue;
    const stepIndent = line.match(/^\s*/)[0].length;
    let end = index + 1;
    while (end < lines.length) {
      const indent = lines[end].match(/^\s*/)[0].length;
      if (indent === stepIndent && lines[end].trimStart().startsWith('- ')) break;
      end++;
    }
    if (!lines.slice(index + 1, end).some((later) => /^\s+persist-credentials:\s*false\s*$/.test(later))) {
      throw new Error(`${name} checkout lacks persist-credentials: false at line ${index + 1}`);
    }
  }
}

// Fork validation is now a requirement, not a permission: without it a public
// repository accepts contributions no gate has ever seen.
if (!/^  pull_request:$/m.test(workflow)) throw new Error('fork pull requests must be validated');
if (!workflow.includes('workflow_dispatch:')) throw new Error('trusted manual matrix trigger missing');
if ((workflow.match(/\bpermissions:/g) ?? []).length !== 1 || !/^permissions:\n  contents: read$/m.test(workflow)) {
  throw new Error('workflow permissions must be only top-level contents: read');
}

// The release workflow is the only thing here that can write outside the
// repository, so its authority is scoped per job rather than granted at the
// top. `id-token: write` mints the OIDC token npm exchanges for provenance and
// belongs to the publishing job alone; `contents: write` belongs to the job
// that creates the GitHub release. Granting either at the top level would hand
// them to every job, including the one that runs the test suite.
if (!/^on:\n  push:\n    tags: \['v\*'\]$/m.test(release)) throw new Error('release must be driven by a version tag');
if (!/^permissions:\n  contents: read$/m.test(release)) throw new Error('release must default to read-only authority');
if ((release.match(/id-token: write/g) ?? []).length !== 1) throw new Error('exactly one job may mint an OIDC token');
if ((release.match(/contents: write/g) ?? []).length !== 1) throw new Error('exactly one job may write repository contents');
for (const [job, granted] of [['publish', 'id-token: write'], ['github-release', 'contents: write']]) {
  const body = release.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z-]+:\n/)[0];
  if (!body) throw new Error(`release job not found: ${job}`);
  if (!body.includes(granted)) throw new Error(`${granted} must be scoped to the ${job} job`);
}
if (!release.includes('npm publish --provenance --access public')) {
  throw new Error('the published package must carry a provenance attestation');
}
// Publication is gated on the digest the matrix attested, not on the tag alone.
if (!release.includes('task-967-matrix.json') || !release.includes('npm pack') ||
    !/GITHUB_REF_NAME" != "v\$version/.test(release)) {
  throw new Error('release must verify the tag and the attested candidate digest');
}
if (!release.includes('needs: verify') || !release.includes('needs: publish')) {
  throw new Error('publish and release must depend on the verification job');
}
const retiredProductJob = ['linux', 'arm64'].join('-');
if (!workflow.includes('macos-arm64:') || workflow.includes(`\n  ${retiredProductJob}:\n`)) {
  throw new Error('workflow must contain only the macOS ARM64 product matrix');
}
if ((workflow.match(/node-version: \[22\.19\.0, 24\.x\]/g) ?? []).length !== 1 ||
    (workflow.match(/pi-version: \[0\.84\.2\]/g) ?? []).length !== 1 ||
    (workflow.match(/mempalace-version: \[3\.6\.0, 3\.7\.1\]/g) ?? []).length !== 1) {
  throw new Error('macOS packaged acceptance matrix is incomplete');
}
if (!workflow.includes('needs.candidate.outputs.sha256') || !workflow.includes('EXPECTED_SOURCE_COMMIT=') ||
    !workflow.includes('git status --porcelain --untracked-files=all') ||
    !workflow.includes('npm run check:repository') || !workflow.includes('gate-release.sh') ||
    !workflow.includes('--tarball')) {
  throw new Error('candidate/source identity enforcement missing');
}
const quick = workflow.split('\n  quick:\n')[1]?.split('\n  candidate:\n')[0];
if (!quick?.includes('bash scripts/gate-ci.sh')) throw new Error('quick job does not run the CI integrity gate');
const macos = workflow.split('\n  macos-arm64:\n')[1]?.split('\n  matrix-evidence:\n')[0];
if (!macos) throw new Error('macos-arm64 job not found');
if (!macos.includes('npm ci --ignore-scripts') || !macos.includes('MEMPALACE_MATRIX_EVIDENCE=') ||
    !macos.includes('name: matrix-evidence-') || !macos.includes('test -s "$MEMPALACE_MATRIX_EVIDENCE"')) {
  throw new Error('macOS matrix does not persist complete cell evidence');
}
// Each cell must persist the record it measured, and the records must be joined
// into the committed evidence. Without this the cells printed their findings to
// a log that was discarded, and refreshing the matrix meant re-running the whole
// thing locally and assembling the file by hand — a manual step over evidence,
// which is precisely where a hand-written digest gets in.
if (!workflow.includes('aggregate-matrix-evidence.mjs')) {
  throw new Error('per-cell records are never aggregated into committed evidence');
}
// The aggregate is published for a human to commit. Committing from CI would
// need `contents: write` in a workflow that also runs fork pull requests, which
// is a much larger grant than refreshing one evidence file is worth.
if (/git (?:commit|push)/u.test(workflow)) {
  throw new Error('CI must not write to the repository; publish the evidence as an artifact');
}
if (!gate.includes('EXPECTED_PLATFORM=') || !gate.includes('process.platform')) {
  throw new Error('host mismatch self-check is not bound to the host environment');
}
NODE

tarball=""
expected_sha=""
source_commit=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tarball)
      [[ -n "${2:-}" ]] || { echo '--tarball requires a path' >&2; exit 2; }
      tarball="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$2")"
      shift 2 ;;
    --sha256)
      [[ -n "${2:-}" ]] || { echo '--sha256 requires a value' >&2; exit 2; }
      expected_sha="$2"
      shift 2 ;;
    --commit)
      [[ -n "${2:-}" ]] || { echo '--commit requires a value' >&2; exit 2; }
      source_commit="$2"
      shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

root="$PWD"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [[ -z "$tarball" ]]; then
  pack_json="$(npm pack --json --pack-destination "$tmp")"
  filename="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(p[0].filename)' <<<"$pack_json")"
  tarball="$tmp/$filename"
else
  [[ -n "$expected_sha" ]] || { echo '--sha256 is required with --tarball' >&2; exit 2; }
  [[ -n "$source_commit" ]] || { echo '--commit is required with --tarball' >&2; exit 2; }
fi
[[ -f "$tarball" ]] || { echo "candidate tarball missing: $tarball" >&2; exit 2; }
actual_sha="$(shasum -a 256 "$tarball" | awk '{print $1}')"
if [[ -n "$expected_sha" && "$actual_sha" != "$expected_sha" ]]; then
  echo 'candidate SHA-256 does not match matrix identity' >&2
  exit 1
fi
actual_commit="$(git rev-parse HEAD)"
if [[ -n "$source_commit" && "$actual_commit" != "$source_commit" ]]; then
  echo 'source commit does not match checkout' >&2
  exit 1
fi

mismatch_dir="$tmp/mismatch"
host_platform="$(node -p 'process.platform')"
host_arch="$(node -p 'process.arch')"
host_node="$(node -p 'process.version.slice(1)')"
if env -u EXPECTED_SOURCE_COMMIT \
  EXPECTED_PLATFORM="$host_platform" EXPECTED_ARCH="$host_arch" EXPECTED_NODE_VERSION="$host_node" \
  EXPECTED_CANDIDATE_SHA256="$(printf '0%.0s' {1..64})" RELEASE_EVIDENCE_DIR="$mismatch_dir" \
  node scripts/release-gate.mjs --runs 1 --tarball "$tarball" >/dev/null 2>&1; then
  echo 'mismatched candidate evidence unexpectedly passed' >&2
  exit 1
fi
node - "$mismatch_dir/latest.json" <<'NODE'
const fs = require('node:fs');
const evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (evidence.verdict !== 'BLOCKED' || !evidence.error?.includes('SHA-256 differs')) {
  throw new Error('candidate mismatch did not produce explicit BLOCKED evidence');
}
NODE

printf 'CI gate: PASS\n'
