#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

command -v actionlint >/dev/null || { echo 'actionlint is required' >&2; exit 1; }
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
actionlint .github/workflows/ci.yml
npm run check:repository

node - <<'NODE'
const fs = require('node:fs');
const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const gate = fs.readFileSync('scripts/gate-ci.sh', 'utf8');
if (/\bpull_request(?:_target)?\b/.test(workflow)) {
  throw new Error('untrusted pull requests must not reach self-hosted runners');
}
if (!workflow.includes('workflow_dispatch:')) throw new Error('trusted manual matrix trigger missing');
if ((workflow.match(/\bpermissions:/g) ?? []).length !== 1 || !/^permissions:\n  contents: read$/m.test(workflow)) {
  throw new Error('workflow permissions must be only top-level contents: read');
}
if (!workflow.includes('macos-arm64:') || !workflow.includes('linux-arm64:')) throw new Error('ARM64 matrix jobs missing');
if ((workflow.match(/node-version: \[22\.19\.0, 24\.x\]/g) ?? []).length !== 2) {
  throw new Error('Node 22.19.0/24.x matrices missing');
}
if ((workflow.match(/pi-version: \[0\.84\.2\]/g) ?? []).length !== 2 ||
    (workflow.match(/mempalace-version: \[3\.6\.0, 3\.7\.1\]/g) ?? []).length !== 2 ||
    !workflow.includes('gate-release.sh') || !workflow.includes('--mempalace-version')) {
  throw new Error('Pi/MemPalace packaged acceptance matrices missing');
}
for (const line of workflow.split('\n').filter((line) => line.includes('uses:'))) {
  if (!/uses: [^@]+@[a-f0-9]{40}(?:\s|$)/.test(line)) throw new Error(`action is not SHA-pinned: ${line.trim()}`);
}
const lines = workflow.split('\n');
for (const [index, line] of lines.entries()) {
  if (!line.includes('uses: actions/checkout@')) continue;
  const stepIndent = line.match(/^\s*/)[0].length;
  let end = index + 1;
  while (end < lines.length) {
    const indent = lines[end].match(/^\s*/)[0].length;
    if (indent === stepIndent && lines[end].trimStart().startsWith('- ')) break;
    end++;
  }
  const step = lines.slice(index + 1, end);
  if (!step.some((later) => /^\s+persist-credentials:\s*false\s*$/.test(later))) {
    throw new Error(`checkout lacks persist-credentials: false at line ${index + 1}`);
  }
}
if (!workflow.includes('needs.candidate.outputs.sha256') || !workflow.includes('EXPECTED_SOURCE_COMMIT=') ||
    !workflow.includes('git status --porcelain --untracked-files=all') ||
    !workflow.includes('npm run check:repository') ||
    !workflow.includes('gate-release.sh') || !workflow.includes('--tarball')) {
  throw new Error('candidate/source identity enforcement missing');
}
if ((gate.match(/node@sha256:[a-f0-9]{64}/g) ?? []).length !== 2) {
  throw new Error('Linux Node images must be digest-pinned');
}
const macos_arm64_job = workflow.split('macos-arm64:')[1]?.split('linux-arm64:')[0];
if (!macos_arm64_job) throw new Error('macos-arm64 job not found');
if (!macos_arm64_job.includes('npm ci --ignore-scripts')) {
  throw new Error('macOS npm install must use npm ci --ignore-scripts for supply-chain safety');
}
NODE

linux_version=""
mempalace_version=""
tarball=""
expected_sha=""
source_commit=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --linux) linux_version="${2:-}"; shift 2 ;;
    --mempalace-version) mempalace_version="${2:-}"; shift 2 ;;
    --tarball) tarball="${2:-}"; shift 2 ;;
    --sha256) expected_sha="${2:-}"; shift 2 ;;
    --commit) source_commit="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

root="$PWD"
tmp="$(mktemp -d)"
uv_container=""
trap '[[ -z "$uv_container" ]] || docker rm -f "$uv_container" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

if [[ -z "$tarball" ]]; then
  pack_json="$(npm pack --json --pack-destination "$tmp")"
  filename="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(p[0].filename)' <<<"$pack_json")"
  tarball="$tmp/$filename"
else
  [[ -n "$expected_sha" ]] || { echo '--sha256 is required with --tarball' >&2; exit 2; }
  [[ -n "$source_commit" ]] || { echo '--commit is required with --tarball' >&2; exit 2; }
  tarball="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$tarball")"
fi
[[ -f "$tarball" ]] || { echo "candidate tarball missing: $tarball" >&2; exit 2; }
actual_sha="$(shasum -a 256 "$tarball" | awk '{print $1}')"
if [[ -n "$expected_sha" && "$actual_sha" != "$expected_sha" ]]; then
  echo 'candidate SHA-256 does not match matrix identity' >&2
  exit 1
fi
expected_sha="$actual_sha"

uv_image='ghcr.io/astral-sh/uv@sha256:4de5495181a281bc744845b9579acf7b221d6791f99bcc211b9ec13f417c2853'
uv_container="$(docker create --platform linux/arm64 "$uv_image")"
docker cp "$uv_container:/uv" "$tmp/uv"
docker rm "$uv_container" >/dev/null
uv_container=""
chmod +x "$tmp/uv"

mismatch_dir="$tmp/mismatch"
if EXPECTED_CANDIDATE_SHA256="$(printf '0%.0s' {1..64})" RELEASE_EVIDENCE_DIR="$mismatch_dir" \
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

run_linux() {
  local version="$1" image expected_node
  case "$version" in
    22.19.0) image='node@sha256:afff6d8c97964a438d2e6a9c96509367e45d8bf93f790ad561a1eaea926303d9'; expected_node='v22.19.0' ;;
    24.x) image='node@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584'; expected_node='v24.' ;;
    *) echo "unsupported Linux Node version: $version" >&2; return 2 ;;
  esac
  docker run --rm --init --platform linux/arm64 --cap-drop ALL --security-opt no-new-privileges \
    -e EXPECTED_CANDIDATE_SHA256="$expected_sha" -e MATRIX_SOURCE_COMMIT="$source_commit" \
    -e EXPECTED_PLATFORM=linux -e EXPECTED_ARCH=arm64 -e EXPECTED_NODE_VERSION="$version" \
    -e EXPECTED_NODE="$expected_node" -e MEMPALACE_ACCEPTANCE_VERSION="$mempalace_version" \
    -v "$root:/source:ro" \
    -v "$tarball:/candidate/mempalace-for-pi-0.1.0.tgz:ro" \
    -v "$tmp/uv:/usr/local/bin/uv:ro" \
    "$image" bash -lc '
      set -euo pipefail
      [[ "$(uname -m)" == "aarch64" ]]
      [[ "$(node --version)" == "$EXPECTED_NODE"* ]]
      mkdir /work /tmp/home /tmp/pi-agent /tmp/npm-cache
      tar -C /source --exclude=node_modules --exclude=candidate --exclude=.release-evidence \
        -cf - . | tar -C /work -xf -
      cd /work
      export HOME=/tmp/home PI_CODING_AGENT_DIR=/tmp/pi-agent npm_config_cache=/tmp/npm-cache
      export NPM_CONFIG_USERCONFIG=/dev/null
      if [[ -n "$MATRIX_SOURCE_COMMIT" ]]; then export EXPECTED_SOURCE_COMMIT="$MATRIX_SOURCE_COMMIT"; fi
      npm ci
      export PI_BINARY=/work/node_modules/.bin/pi
      release_args=(--tarball /candidate/mempalace-for-pi-0.1.0.tgz)
      if [[ -n "$MEMPALACE_ACCEPTANCE_VERSION" ]]; then
        release_args+=(--mempalace-version "$MEMPALACE_ACCEPTANCE_VERSION")
      fi
      bash scripts/gate-release.sh "${release_args[@]}"
    '
}

if [[ -n "$linux_version" ]]; then
  run_linux "$linux_version"
else
  run_linux 22.19.0
  run_linux 24.x
fi

printf 'CI gate: PASS\n'
