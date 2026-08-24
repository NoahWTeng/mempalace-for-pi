#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

command -v actionlint >/dev/null || { echo 'actionlint is required' >&2; exit 1; }
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
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
  // The invariant that replaced the old blanket `pull_request` ban. That ban
  // existed because these jobs ran on the maintainer's own machine, where a
  // fork's code must never execute. Hosted runners are disposable and hold no
  // credentials, so validating fork pull requests is both safe and necessary —
  // but only while no job reintroduces a self-hosted runner. Checking the cause
  // instead of the symptom is what keeps `pull_request` from silently becoming
  // dangerous again.
  //
  // Only `runs-on:` decides where a job executes, so only `runs-on:` is
  // inspected. Matching the whole file would make the comment above — which
  // explains why this rule exists — trip the rule itself, and a guard that
  // forbids describing the hazard it guards against gets weakened by whoever
  // next needs to write that sentence.
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
if (!workflow.includes('macos-arm64:') || !workflow.includes('linux-arm64:')) throw new Error('ARM64 matrix jobs missing');
if ((workflow.match(/node-version: \[22\.19\.0, 24\.x\]/g) ?? []).length !== 2) {
  throw new Error('Node 22.19.0/24.x matrices missing');
}
if ((workflow.match(/pi-version: \[0\.84\.2\]/g) ?? []).length !== 2 ||
    (workflow.match(/mempalace-version: \[3\.6\.0, 3\.7\.1\]/g) ?? []).length !== 2 ||
    !workflow.includes('gate-release.sh') || !workflow.includes('--mempalace-version')) {
  throw new Error('Pi/MemPalace packaged acceptance matrices missing');
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
      # --no-same-owner because this container deliberately runs with
      # --cap-drop ALL. Extracting as root, tar tries to restore the original
      # uid/gid of every entry, which needs CAP_CHOWN, which was dropped on
      # purpose, so the copy aborts. Everything inside runs as root regardless,
      # so the ownership being restored is meaningless here; dropping the
      # attempt keeps the capability restriction intact rather than relaxing it.
      # Docker Desktop on macOS masks this by mapping ownership on the bind
      # mount, so it only ever appears on a native Linux host.
      tar -C /source --exclude=node_modules --exclude=candidate --exclude=.release-evidence \
        -cf - . | tar -C /work --no-same-owner -xf -
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
