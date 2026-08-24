#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

candidate_tarball=""
mempalace_version=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tarball)
      [[ -n "${2:-}" ]] || { echo '--tarball requires a path' >&2; exit 2; }
      candidate_tarball="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$2")"
      shift 2 ;;
    --mempalace-version)
      [[ -n "${2:-}" ]] || { echo '--mempalace-version requires a value' >&2; exit 2; }
      mempalace_version="$2"
      shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$candidate_tarball" || -f "$candidate_tarball" ]] || {
  echo "candidate tarball missing: $candidate_tarball" >&2; exit 2;
}

node - <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
// The invariant is that the three places a version is recorded agree with each
// other, not that they say any one number. Pinning the literal blocked every
// release after the first: `npm version` updates all three consistently, and
// this still threw before a single check ran, with a message claiming the
// metadata was inconsistent when it was perfectly consistent.
if (!/^\d+\.\d+\.\d+$/u.test(pkg.version) ||
    lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
  throw new Error(
    `package metadata is not consistently versioned: package.json ${pkg.version}, ` +
    `lock ${lock.version}, lock root ${lock.packages[''].version}`,
  );
}
NODE

expect_argument_failure() {
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  if [[ $status -eq 0 || "$output" != *'requires a value'* ]]; then
    echo "malformed argument did not fail closed: $*" >&2
    exit 1
  fi
}
expect_argument_failure node scripts/check-package.mjs --tarball
expect_argument_failure node scripts/release-gate.mjs --tarball
expect_argument_failure node scripts/acceptance-extension.mjs --smoke --tarball
for script in scripts/check-package.mjs scripts/release-gate.mjs scripts/acceptance-extension.mjs; do
  set +e
  unknown_output="$(node "$script" --unknown value 2>&1)"
  unknown_status=$?
  set -e
  if [[ $unknown_status -eq 0 || "$unknown_output" != *'unknown argument'* ]]; then
    echo "unknown argument did not fail closed: $script" >&2
    exit 1
  fi
done
for binding in EXPECTED_PLATFORM EXPECTED_SOURCE_COMMIT EXPECTED_CANDIDATE_SHA256; do
  set +e
  binding_output="$(env "$binding=" RELEASE_EVIDENCE_DIR="$tmp/empty-$binding" \
    node scripts/release-gate.mjs --runs 1 2>&1)"
  binding_status=$?
  set -e
  if [[ $binding_status -eq 0 || "$binding_output" != *'must not be empty'* ]]; then
    echo "empty identity binding did not fail closed: $binding (status=$binding_status): $binding_output" >&2
    exit 1
  fi
done

with_candidate() {
  if [[ -n "$candidate_tarball" ]]; then
    "$@" --tarball "$candidate_tarball"
  else
    "$@"
  fi
}

with_candidate node scripts/check-package.mjs
acceptance_args=(--smoke --runs 1)
[[ -z "$candidate_tarball" ]] || acceptance_args+=(--tarball "$candidate_tarball")
[[ -z "$mempalace_version" ]] || acceptance_args+=(--mempalace-version "$mempalace_version")
node scripts/acceptance-extension.mjs "${acceptance_args[@]}"

success="$tmp/success"
RELEASE_EVIDENCE_DIR="$success" with_candidate node scripts/release-gate.mjs --runs 3
node - "$success" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const directory = process.argv[2];
const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json'));
if (files.length !== 1) throw new Error(`expected one PASS evidence file, found ${files.length}`);
const evidence = JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8'));
if (evidence.verdict !== 'PASS') throw new Error('release evidence did not pass');
if (evidence.candidate.version !== '0.1.0' || !/^[a-f0-9]{64}$/.test(evidence.candidate.sha256)) {
  throw new Error('candidate identity is incomplete');
}
if (!evidence.environment.node || !evidence.environment.pi || !evidence.environment.platform || !evidence.environment.arch) {
  throw new Error('environment evidence is incomplete');
}
if (evidence.checks.length !== 9 || evidence.checks.some((check) => check.outcome !== 'PASS' || check.durationMs < 0)) {
  throw new Error('required check evidence is incomplete');
}
if (!Array.isArray(evidence.knownLimitations) || evidence.knownLimitations.length === 0) {
  throw new Error('known limitations are missing');
}
if (!evidence.security.findings || !Array.isArray(evidence.security.acceptedRisks) ||
    !evidence.security.auditScope || !Array.isArray(evidence.enforcedBindings) ||
    typeof evidence.source?.commit !== 'string') {
  throw new Error('security/source findings are incomplete');
}
NODE

failure="$tmp/failure"
mkdir -p "$failure"
cp "$success/latest.json" "$failure/latest.json"
if RELEASE_EVIDENCE_DIR="$failure" PI_BINARY=/missing with_candidate node scripts/release-gate.mjs --runs 1; then
  echo 'forced release failure unexpectedly passed' >&2
  exit 1
fi
node - "$failure" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const directory = process.argv[2];
const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json'));
if (files.length !== 1) throw new Error(`expected one BLOCKED evidence file, found ${files.length}`);
const evidence = JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8'));
if (evidence.verdict === 'PASS') throw new Error('failed gate retained a PASS verdict');
NODE

real_npm="$(command -v npm)"
fake_bin="$tmp/fake-bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/npm" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "audit" ]]; then
  printf '%s\n' '{"auditReportVersion":2,"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":1,"critical":0,"total":1}}}'
  exit 1
fi
exec "$REAL_NPM" "$@"
SH
chmod +x "$fake_bin/npm"
audit_failure="$tmp/audit-failure"
if PATH="$fake_bin:$PATH" REAL_NPM="$real_npm" RELEASE_EVIDENCE_DIR="$audit_failure" \
  with_candidate node scripts/release-gate.mjs --runs 1; then
  echo 'High-severity audit failure unexpectedly passed' >&2
  exit 1
fi
node - "$audit_failure/latest.json" <<'NODE'
const fs = require('node:fs');
const evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (evidence.verdict !== 'BLOCKED' || evidence.security.findings?.high !== 1) {
  throw new Error('blocked audit evidence omitted High finding details');
}
NODE

tarball="$candidate_tarball"
if [[ -z "$tarball" ]]; then
  pack_json="$(npm pack --json --pack-destination "$tmp")"
  tarball="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(p[0].filename)' <<<"$pack_json")"
  tarball="$tmp/$tarball"
fi

expect_reject() {
  local name="$1" path="$2" content="$3" expected="$4"
  local root="$tmp/bad-$name" output status
  mkdir -p "$root"
  tar -xzf "$tarball" -C "$root"
  mkdir -p "$(dirname "$root/package/$path")"
  printf '%s\n' "$content" > "$root/package/$path"
  tar -czf "$root.tgz" -C "$root" package
  set +e
  output="$(node scripts/check-package.mjs --tarball "$root.tgz" 2>&1)"
  status=$?
  set -e
  if [[ $status -eq 0 || "$output" != *"$expected"* ]]; then
    echo "package inspection did not reject $name for expected reason: $output" >&2
    exit 1
  fi
}

expect_reject credential-file integration/credentials.json '{}' 'credential file'
expect_reject env-suffix integration/config.env 'TOKEN=value' 'credential file'
expect_reject private-key integration/leak.ts '-----BEGIN PRIVATE KEY-----' 'credential content'
expect_reject anthropic-token integration/anthropic.ts 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 'credential content'
expect_reject openai-token integration/openai.ts 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 'credential content'
expect_reject google-token integration/google.ts 'AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 'credential content'
expect_reject github-token integration/github.ts 'github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 'credential content'
expect_reject npm-token integration/npm.ts '//registry.npmjs.org/:_authToken=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 'credential content'
expect_reject npmrc integration/.npmrc "//npm.pkg.github.com/:_authToken=$(printf 'A%.0s' {1..40})" 'credential file'
expect_reject npm-auth integration/npm-auth.ts "//registry.example.com/:_auth=$(printf 'A%.0s' {1..40})" 'credential content'
expect_reject gitlab-token integration/gitlab.ts "glpat-$(printf 'A%.0s' {1..30})" 'credential content'
expect_reject huggingface-token integration/hf.ts "hf_$(printf 'A%.0s' {1..30})" 'credential content'
expect_reject google-oauth integration/oauth.ts "GOCSPX-$(printf 'A%.0s' {1..30})" 'credential content'
expect_reject stripe-token integration/stripe.ts "sk_live_$(printf 'A%.0s' {1..30})" 'credential content'
expect_reject aws-secret integration/aws.ts "aws_secret_access_key=$(printf 'A%.0s' {1..40})" 'credential content'
expect_reject aws-json integration/aws-json.ts "{\"aws_secret_access_key\": \"$(printf 'A%.0s' {1..40})\"}" 'credential content'
expect_reject aws-quoted integration/aws-quoted.ts "const aws_secret_access_key = '$(printf 'A%.0s' {1..40})';" 'credential content'
expect_reject aws-slash integration/aws-slash.ts "aws_secret_access_key=$(printf 'A%.0s' {1..39})/" 'credential content'
expect_reject absolute-path integration/path.ts '/Users/maintainer/private/config.json' 'absolute internal path'
expect_reject historical-src src/index.ts 'unsupported runtime' 'unrelated file'
expect_reject memory-database memory.sqlite 'not a database' 'local memory payload'
expect_reject generated-state test-state/result.json '{}' 'generated test state'
expect_reject unrelated-file notes.txt 'not part of the package' 'unrelated file'
expect_reject lifecycle-hook package.json '{"name":"mempalace-for-pi","version":"0.1.0","scripts":{"postinstall":"exit 1"}}' 'npm lifecycle hook'

binary_root="$tmp/bad-binary"
mkdir -p "$binary_root"
tar -xzf "$tarball" -C "$binary_root"
printf '\0-----BEGIN PRIVATE KEY-----\n' > "$binary_root/package/integration/binary.ts"
tar -czf "$binary_root.tgz" -C "$binary_root" package
set +e
binary_output="$(node scripts/check-package.mjs --tarball "$binary_root.tgz" 2>&1)"
binary_status=$?
set -e
if [[ $binary_status -eq 0 || "$binary_output" != *'binary content'* ]]; then
  echo "package inspection did not reject binary payload for expected reason: $binary_output" >&2
  exit 1
fi

npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
printf 'Release gate: PASS\n'
