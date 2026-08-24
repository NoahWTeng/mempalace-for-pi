#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PI_VERSION="0.84.2"
MEMPALACE_VERSIONS=("3.6.0" "3.7.1")
PYPI_INDEX="https://pypi.org/simple"
tarball=""
selected_version=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tarball) tarball="${2:-}"; shift 2 ;;
    --mempalace-version) selected_version="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -n "$selected_version" ]]; then
  [[ " ${MEMPALACE_VERSIONS[*]} " == *" $selected_version "* ]] || {
    echo "unsupported MemPalace acceptance version: $selected_version" >&2; exit 2;
  }
  MEMPALACE_VERSIONS=("$selected_version")
fi

root="$PWD"
node_bin_dir="$(dirname "$(command -v node)")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export NPM_CONFIG_USERCONFIG=/dev/null UV_NO_CONFIG=1
unset UV_EXTRA_INDEX_URL UV_INDEX UV_INDEX_URL UV_DEFAULT_INDEX UV_FIND_LINKS \
  PIP_INDEX_URL PIP_EXTRA_INDEX_URL npm_config_registry NPM_CONFIG_REGISTRY
if [[ -z "$tarball" ]]; then
  pack_json="$(npm pack --json --pack-destination "$tmp")"
  filename="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(p[0].filename)' <<<"$pack_json")"
  tarball="$tmp/$filename"
else
  tarball="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$tarball")"
fi
[[ -f "$tarball" ]] || { echo "candidate tarball missing: $tarball" >&2; exit 2; }
candidate_sha="$(shasum -a 256 "$tarball" | awk '{print $1}')"
if [[ -n "${EXPECTED_CANDIDATE_SHA256:-}" && "$candidate_sha" != "$EXPECTED_CANDIDATE_SHA256" ]]; then
  echo 'candidate SHA-256 does not match matrix identity' >&2; exit 1
fi
source_commit="${EXPECTED_SOURCE_COMMIT:-$(git rev-parse HEAD)}"
[[ "$source_commit" == "$(git rev-parse HEAD)" ]] || { echo 'source commit does not match checkout' >&2; exit 1; }
source_tree="$(git rev-parse 'HEAD^{tree}')"
node scripts/check-package.mjs --tarball "$tarball"
node --test test/mempalace/packaged-acceptance.test.mjs

palace_digest() {
  node - "$1" <<'NODE'
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const root=process.argv[2], hash=crypto.createHash('sha256');
function walk(dir) { for (const name of fs.readdirSync(dir).sort()) { const full=path.join(dir,name), rel=path.relative(root,full); const stat=fs.lstatSync(full); hash.update(rel+'\0'+stat.mode+'\0'); if (stat.isDirectory()) walk(full); else hash.update(fs.readFileSync(full)); } }
walk(root); process.stdout.write(hash.digest('hex'));
NODE
}

for version in "${MEMPALACE_VERSIONS[@]}"; do
  job="$tmp/mempalace-$version"
  consumer="$job/consumer"
  palace="$job/palace"
  agent="$job/agent"
  network="$job/non-loopback.log"
  core_pid_file="$job/core.pid"
  mkdir -p "$consumer" "$palace" "$agent" "$job/home" "$job/bin" "$job/npm-cache" "$job/uv-cache"
  : > "$network"
  cat > "$consumer/package.json" <<'JSON'
{"name":"mempalace-packaged-acceptance","version":"1.0.0","private":true}
JSON

  export npm_config_cache="$job/npm-cache" UV_CACHE_DIR="$job/uv-cache"
  install_started="$(date +%s)"
  uv venv --python 3.12 "$job/venv" >/dev/null
  printf 'mempalace==%s\n' "$version" > "$job/requirements.in"
  uv pip compile "$job/requirements.in" --python "$job/venv/bin/python" \
    --index-url "$PYPI_INDEX" --index-strategy first-index --only-binary :all: \
    --generate-hashes -o "$job/requirements.lock" >/dev/null
  uv pip sync --python "$job/venv/bin/python" --index-url "$PYPI_INDEX" \
    --index-strategy first-index --only-binary :all: --require-hashes "$job/requirements.lock" >/dev/null
  npm install --prefix "$consumer" --ignore-scripts --no-audit --no-fund \
    "@earendil-works/pi-coding-agent@$PI_VERSION" 'typebox@1.3.7' >/dev/null
  install_seconds=$(( $(date +%s) - install_started ))
  (( install_seconds < 600 )) || { echo "clean install exceeded 10 minutes: ${install_seconds}s" >&2; exit 1; }

  pi_bin="$consumer/node_modules/.bin/pi"
  core_bin="$job/venv/bin/mempalace-mcp"
  [[ "$("$pi_bin" --version)" == "$PI_VERSION" ]]
  [[ "$("$job/venv/bin/mempalace" --version)" == "MemPalace $version" ]]
  # Provision only the official local search model in a throwaway palace. All
  # acceptance records below are created later with both guards enforced.
  mkdir -p "$job/asset-source"
  printf 'asset provision probe for the local exact-search model\n' > "$job/asset-source/probe.md"
  env HOME="$job/home" MEMPALACE_BACKEND=sqlite_exact MEMPALACE_BACKEND_EXPLICIT=sqlite_exact \
    "$job/venv/bin/mempalace" --palace "$job/asset-provision-palace" --backend sqlite_exact \
    mine "$job/asset-source" >/dev/null
  env HOME="$job/home" MEMPALACE_BACKEND=sqlite_exact MEMPALACE_BACKEND_EXPLICIT=sqlite_exact \
    "$job/venv/bin/mempalace" --palace "$job/asset-provision-palace" --backend sqlite_exact \
    search 'asset provision probe' >/dev/null
  cat > "$job/bin/mempalace-mcp" <<'SH'
#!/bin/sh
printf '%s\n' "$$" > "$MEMPALACE_CORE_PID_FILE"
exec "$MEMPALACE_OFFICIAL_CORE" "$@"
SH
  chmod +x "$job/bin/mempalace-mcp"

  routine_env=(
    "HOME=$job/home"
    "PI_CODING_AGENT_DIR=$agent"
    "PI_OFFLINE=1"
    "PI_TELEMETRY=0"
    "MEMPALACE_PALACE=$palace"
    "MEMPALACE_BACKEND=sqlite_exact"
    "MEMPALACE_BACKEND_EXPLICIT=sqlite_exact"
    "MEMPALACE_NETWORK_EVIDENCE=$network"
    "MEMPALACE_CORE_PID_FILE=$core_pid_file"
    "MEMPALACE_OFFICIAL_CORE=$core_bin"
    "PYTHONPATH=$root/test/mempalace/fixtures"
    "PYTHONDONTWRITEBYTECODE=1"
    "NODE_OPTIONS=--import=$root/test/mempalace/fixtures/network-guard.mjs"
    "PATH=$job/bin:$job/venv/bin:$consumer/node_modules/.bin:$node_bin_dir:/usr/bin:/bin"
  )
  candidate_source="npm:mempalace-for-pi@file:$tarball"

  env HOME="$job/home" PI_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
    NPM_CONFIG_USERCONFIG=/dev/null npm_config_cache="$job/npm-cache" PATH="${PATH}" \
    "$pi_bin" install "$candidate_source" >/dev/null
  list_output="$(env HOME="$job/home" PI_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 "$pi_bin" list)"
  [[ "$list_output" == *"$candidate_source"* && "$list_output" == *"mempalace-for-pi"* ]]
  package_dir="$agent/npm/node_modules/mempalace-for-pi"
  [[ -f "$package_dir/extensions/index.ts" ]]

  run_pi() {
    (cd "$consumer" && env "${routine_env[@]}" "$@" "$pi_bin" \
      --mode text --print --no-session --no-builtin-tools --no-skills --no-prompt-templates \
      --no-themes --no-context-files --provider mempalace-packaged-local --model scripted \
      --api-key local-only -e "$root/test/mempalace/fixtures/packaged-provider.ts" RUN_PACKAGED_JOURNEY)
  }
  assert_core_gone() {
    local core_pid_path="${1:-$core_pid_file}"
    [[ ! -f "$core_pid_path" ]] && return
    local pid
    pid="$(cat "$core_pid_path")"
    if kill -0 "$pid" 2>/dev/null || kill -0 -- "-$pid" 2>/dev/null; then
      echo "official core process/group survived Pi shutdown" >&2; exit 1
    fi
  }
  run_verify() {
    local phase="$1" create="${2:-}" runtime_dir="$consumer/package-under-test"
    rm -rf "$runtime_dir"
    cp -R "$package_dir" "$runtime_dir"
    rm -f "$core_pid_file"
    local args=(--package-dir "$runtime_dir" --mempalace-bin "$core_bin" --mempalace-version "$version"
      --palace "$palace" --network-evidence "$network" --phase "$phase")
    [[ "$create" == create ]] && args+=(--create-records)
    (cd "$consumer" && env "${routine_env[@]}" node --experimental-strip-types \
      "$root/test/mempalace/packaged-real-provider.mjs" "${args[@]}")
  }
  assert_snapshot() {
    node -e 'const a=JSON.parse(process.argv[1]),b=JSON.parse(process.argv[2]);require("node:assert/strict").deepEqual(b.snapshot,a.snapshot)' "$1" "$2"
  }

  rm -f "$core_pid_file"
  provider_output="$(run_pi)"
  [[ "$provider_output" == *"PACKAGED_PROVIDER_PASS"* ]] || { echo "$provider_output" >&2; exit 1; }
  assert_core_gone

  baseline="$(run_verify current-before-disable create)"
  [[ "$baseline" == *'"importedFrom":"installed-package-copy"'*'"concurrentWriteCount":1'* && "$baseline" == *'"handoffExact":true'* ]]
  baseline_digest="$(palace_digest "$palace")"

  node - "$agent/settings.json" "$candidate_source" <<'NODE'
const fs=require('node:fs'); const [file,source]=process.argv.slice(2);
const settings=JSON.parse(fs.readFileSync(file,'utf8')); settings.packages=[{source,extensions:[]}]; fs.writeFileSync(file,JSON.stringify(settings,null,2)+'\n');
NODE
  rm -f "$core_pid_file"
  disabled_output="$(run_pi MEMPALACE_PROVIDER_EXPECT_DISABLED=1)"
  [[ "$disabled_output" == *'PACKAGED_PROVIDER_PASS'*'"disabled":true'* ]]
  [[ ! -f "$core_pid_file" ]]
  [[ "$(palace_digest "$palace")" == "$baseline_digest" ]]

  node - "$agent/settings.json" "$candidate_source" <<'NODE'
const fs=require('node:fs'); const [file,source]=process.argv.slice(2); fs.writeFileSync(file,JSON.stringify({packages:[source]},null,2)+'\n');
NODE
  after_disable="$(run_verify after-disable)"
  assert_snapshot "$baseline" "$after_disable"

  before_remove_digest="$(palace_digest "$palace")"
  env HOME="$job/home" PI_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
    NPM_CONFIG_USERCONFIG=/dev/null npm_config_cache="$job/npm-cache" "$pi_bin" remove "$candidate_source" >/dev/null
  [[ "$(env HOME="$job/home" PI_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 "$pi_bin" list)" == 'No packages installed.' ]]
  rm -f "$core_pid_file"
  removed_output="$(run_pi MEMPALACE_PROVIDER_EXPECT_DISABLED=1)"
  [[ "$removed_output" == *'PACKAGED_PROVIDER_PASS'*'"disabled":true'* ]]
  [[ ! -f "$core_pid_file" && "$(palace_digest "$palace")" == "$before_remove_digest" ]]

  env HOME="$job/home" PI_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
    NPM_CONFIG_USERCONFIG=/dev/null npm_config_cache="$job/npm-cache" "$pi_bin" install "$candidate_source" >/dev/null
  package_dir="$agent/npm/node_modules/mempalace-for-pi"
  reinstalled="$(run_verify reinstall)"
  assert_snapshot "$baseline" "$reinstalled"

  predecessor_root="$job/predecessor"
  mkdir -p "$predecessor_root"
  tar -xzf "$tarball" -C "$predecessor_root"
  node - "$predecessor_root/package" <<'NODE'
const fs=require('node:fs'),path=require('node:path'); const root=process.argv[2];
const manifestPath=path.join(root,'package.json'), manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
manifest.version='0.0.9'; fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
fs.appendFileSync(path.join(root,'integration/index.ts'), `\nimport { appendFileSync } from 'node:fs';\nif (process.env.MEMPALACE_PREDECESSOR_SENTINEL) appendFileSync(process.env.MEMPALACE_PREDECESSOR_SENTINEL, 'synthetic-predecessor-0.0.9\\n');\n`);
fs.writeFileSync(path.join(root,'synthetic-predecessor.json'),JSON.stringify({synthetic:true,version:'0.0.9',basis:'candidate with executable sentinel'})+'\n');
NODE
  predecessor="$job/mempalace-for-pi-0.0.9-synthetic.tgz"
  tar -czf "$predecessor" -C "$predecessor_root" package
  [[ "$(shasum -a 256 "$predecessor" | awk '{print $1}')" != "$candidate_sha" ]]
  predecessor_source="npm:mempalace-for-pi@file:$predecessor"

  install_source() {
    local remove_source="$1" add_source="$2"
    env HOME="$job/home" PI_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
      NPM_CONFIG_USERCONFIG=/dev/null npm_config_cache="$job/npm-cache" "$pi_bin" remove "$remove_source" >/dev/null
    env HOME="$job/home" PI_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
      NPM_CONFIG_USERCONFIG=/dev/null npm_config_cache="$job/npm-cache" "$pi_bin" install "$add_source" >/dev/null
    package_dir="$agent/npm/node_modules/mempalace-for-pi"
  }
  sentinel="$job/predecessor-sentinel.log"
  install_source "$candidate_source" "$predecessor_source"
  predecessor_output="$(run_pi MEMPALACE_PROVIDER_VERIFY_ONLY=1 MEMPALACE_PREDECESSOR_SENTINEL="$sentinel")"
  [[ "$predecessor_output" == *'PACKAGED_PROVIDER_PASS'* && "$(cat "$sentinel")" == 'synthetic-predecessor-0.0.9' ]]
  predecessor_evidence="$(run_verify synthetic-predecessor)"
  [[ "$predecessor_evidence" == *'"packageVersion":"0.0.9"'*'"syntheticPredecessor":true'* ]]
  assert_snapshot "$baseline" "$predecessor_evidence"

  install_source "$predecessor_source" "$candidate_source"
  current_evidence="$(run_verify current-upgrade)"
  assert_snapshot "$baseline" "$current_evidence"
  install_source "$candidate_source" "$predecessor_source"
  rollback_evidence="$(run_verify synthetic-rollback)"
  assert_snapshot "$baseline" "$rollback_evidence"
  install_source "$predecessor_source" "$candidate_source"
  final_evidence="$(run_verify current-restored)"
  assert_snapshot "$baseline" "$final_evidence"

  # --- Project-local installation and the .pi/mempalace.json contract -------
  #
  # A project declares its palace in a document it commits, so this journey
  # installs the candidate the way a project installs it, states the trust
  # decision a host would state, and proves the document is read only once that
  # decision exists. The declared palace uses the portable home-relative form,
  # because a committed document is checked out on more than one computer.
  project="$job/project"
  project_agent="$job/project-agent"
  project_home="$job/home"
  project_palace="$project_home/palaces/project"
  override_palace="$job/override-palace"
  project_pid_file="$job/project-core.pid"
  project_document="$project/.pi/mempalace.json"
  mkdir -p "$project/.pi" "$project_agent" "$project_palace" "$override_palace"

  project_env=(
    "HOME=$job/home"
    "PI_CODING_AGENT_DIR=$project_agent"
    "PI_OFFLINE=1"
    "PI_TELEMETRY=0"
    "MEMPALACE_BACKEND=sqlite_exact"
    "MEMPALACE_BACKEND_EXPLICIT=sqlite_exact"
    "MEMPALACE_NETWORK_EVIDENCE=$network"
    "MEMPALACE_CORE_PID_FILE=$project_pid_file"
    "MEMPALACE_OFFICIAL_CORE=$core_bin"
    "PYTHONPATH=$root/test/mempalace/fixtures"
    "PYTHONDONTWRITEBYTECODE=1"
    "NODE_OPTIONS=--import=$root/test/mempalace/fixtures/network-guard.mjs"
    "PATH=$job/bin:$job/venv/bin:$consumer/node_modules/.bin:$node_bin_dir:/usr/bin:/bin"
  )
  # The whole first contract version: one required version and a declared
  # palace, written the way the documentation tells a project to write it.
  project_config_palace='{
  "version": 1,
  "palace": "~/palaces/project"
}'

  write_project_document() { printf '%s\n' "$1" > "$project_document"; }
  project_digest() { palace_digest "$project_palace"; }
  assert_no_core_started() {
    if [[ -f "$project_pid_file" ]]; then
      echo "a refused project document started a core process: $1" >&2
      exit 1
    fi
  }
  assert_project_palace_unchanged() {
    [[ "$(project_digest)" == "$2" ]] || {
      echo "the declared project palace changed during $1" >&2; exit 1;
    }
  }
  run_project_cli() {
    (cd "$project" && env HOME="$job/home" PI_CODING_AGENT_DIR="$project_agent" PI_OFFLINE=1 \
      PI_TELEMETRY=0 NPM_CONFIG_USERCONFIG=/dev/null npm_config_cache="$job/npm-cache" \
      PATH="$consumer/node_modules/.bin:$node_bin_dir:/usr/bin:/bin" "$pi_bin" "$@")
  }
  run_project_pi() {
    local trust="$1"
    shift
    (cd "$project" && env "${project_env[@]}" "$@" "$pi_bin" "$trust" \
      --mode text --print --no-session --no-builtin-tools --no-skills --no-prompt-templates \
      --no-themes --no-context-files --provider mempalace-packaged-local --model scripted \
      --api-key local-only -e "$root/test/mempalace/fixtures/packaged-provider.ts" RUN_PACKAGED_JOURNEY)
  }

  # project-local-install: the candidate is installed into project settings.
  write_project_document "$project_config_palace"
  run_project_cli install -l "$candidate_source" --approve >/dev/null
  project_settings="$project/.pi/settings.json"
  [[ -f "$project_settings" ]] || { echo 'pi install -l wrote no project settings' >&2; exit 1; }
  grep -q 'mempalace-for-pi' "$project_settings"
  [[ -f "$project/.pi/npm/node_modules/mempalace-for-pi/extensions/index.ts" ]]
  project_list="$(run_project_cli list --approve)"
  [[ "$project_list" == *"$candidate_source"* && "$project_list" == *'mempalace-for-pi'* ]]

  # project-json-palace: a trusted session composes four tools and uses the
  # palace the document declares, not the project-default one.
  rm -f "$project_pid_file"
  project_output="$(run_project_pi --approve)"
  [[ "$project_output" == *'PACKAGED_PROVIDER_PASS'*'"disabled":false'* ]] || {
    echo "$project_output" >&2; exit 1;
  }
  [[ -f "$project_pid_file" ]] || { echo 'the declared palace started no core process' >&2; exit 1; }
  assert_core_gone "$project_pid_file"
  [[ -n "$(ls -A "$project_palace")" ]] || {
    echo 'the palace declared by the project document stayed empty' >&2; exit 1;
  }

  # restart: a second session finds the exact records the first one created.
  rm -f "$project_pid_file"
  restart_output="$(run_project_pi --approve MEMPALACE_PROVIDER_VERIFY_ONLY=1)"
  [[ "$restart_output" == *'PACKAGED_PROVIDER_PASS'*'"verifyOnly":true'* ]]
  assert_core_gone "$project_pid_file"

  # env-override: the environment wins over the document, field by field, and
  # the palace the document declared is left untouched.
  before_override_digest="$(project_digest)"
  rm -f "$project_pid_file"
  override_output="$(run_project_pi --approve "MEMPALACE_PALACE=$override_palace")"
  [[ "$override_output" == *'PACKAGED_PROVIDER_PASS'*'"disabled":false'* ]]
  assert_core_gone "$project_pid_file"
  [[ -n "$(ls -A "$override_palace")" ]] || {
    echo 'the environment override wrote no records of its own' >&2; exit 1;
  }
  assert_project_palace_unchanged 'env-override' "$before_override_digest"

  # project-json-disabled: a document that switches the integration off exposes
  # no tool, starts no process, and touches no byte of the palace.
  disabled_document_digest="$(project_digest)"
  write_project_document '{ "version": 1, "disabled": true }'
  rm -f "$project_pid_file"
  disabled_document_output="$(run_project_pi --approve MEMPALACE_PROVIDER_EXPECT_DISABLED=1)"
  [[ "$disabled_document_output" == *'PACKAGED_PROVIDER_PASS'*'"disabled":true'* ]]
  assert_no_core_started 'project-json-disabled'
  assert_project_palace_unchanged 'project-json-disabled' "$disabled_document_digest"

  # untrusted-json-unread: the same disabling document, with trust refused. The
  # project package is skipped when a project is not trusted, so the candidate
  # is installed at user scope for this one run: the tools appear, which is only
  # possible because the document was never read.
  run_project_cli install "$candidate_source" >/dev/null
  rm -f "$project_pid_file"
  untrusted_output="$(run_project_pi --no-approve)"
  [[ "$untrusted_output" == *'PACKAGED_PROVIDER_PASS'*'"disabled":false'* ]] || {
    echo "$untrusted_output" >&2; exit 1;
  }
  [[ -f "$project_pid_file" ]] || {
    echo 'an untrusted session read the disabling document it must not read' >&2; exit 1;
  }
  assert_core_gone "$project_pid_file"
  assert_project_palace_unchanged 'untrusted-json-unread' "$disabled_document_digest"
  run_project_cli remove "$candidate_source" >/dev/null

  # project-json-invalid: every refusal class the loader declares fails the same
  # closed way as a disabling document.
  while IFS= read -r invalid_document <&3; do
    write_project_document "$invalid_document"
    rm -f "$project_pid_file"
    invalid_output="$(run_project_pi --approve MEMPALACE_PROVIDER_EXPECT_DISABLED=1)"
    [[ "$invalid_output" == *'PACKAGED_PROVIDER_PASS'*'"disabled":true'* ]] || {
      echo "$invalid_output" >&2; exit 1;
    }
    assert_no_core_started "project-json-invalid: $invalid_document"
    assert_project_palace_unchanged 'project-json-invalid' "$disabled_document_digest"
  done 3<<'INVALID'
this is not JSON at all
[]
{ "version": 2 }
{ "version": 1, "unknown": true }
{ "version": 1, "readOnly": "yes" }
INVALID

  # project-remove and project-reinstall: removing the project package exposes
  # no tool and no process, and reinstalling finds the exact same records.
  write_project_document "$project_config_palace"
  before_project_remove_digest="$(project_digest)"
  run_project_cli remove -l "$candidate_source" --approve >/dev/null
  rm -f "$project_pid_file"
  project_removed_output="$(run_project_pi --approve MEMPALACE_PROVIDER_EXPECT_DISABLED=1)"
  [[ "$project_removed_output" == *'PACKAGED_PROVIDER_PASS'*'"disabled":true'* ]]
  assert_no_core_started 'project-remove'
  assert_project_palace_unchanged 'project-remove' "$before_project_remove_digest"

  run_project_cli install -l "$candidate_source" --approve >/dev/null
  rm -f "$project_pid_file"
  project_reinstalled_output="$(run_project_pi --approve MEMPALACE_PROVIDER_VERIFY_ONLY=1)"
  [[ "$project_reinstalled_output" == *'PACKAGED_PROVIDER_PASS'*'"verifyOnly":true'* ]]
  assert_core_gone "$project_pid_file"

  fake_bin="$job/fake-bin"
  mkdir -p "$fake_bin"
  cat > "$fake_bin/mempalace-mcp" <<SH
#!/bin/sh
exec "$node_bin_dir/node" "$root/test/mempalace/fixtures/fake-mempalace-server.mjs" incompatible
SH
  chmod +x "$fake_bin/mempalace-mcp"
  rm -f "$core_pid_file"
  set +e
  incompatible_output="$(cd "$consumer" && env "${routine_env[@]}" PATH="$fake_bin:$consumer/node_modules/.bin:$node_bin_dir:/usr/bin:/bin" \
    MEMPALACE_FAKE_PID_FILE="$core_pid_file" MEMPALACE_PROVIDER_EXPECT_INCOMPATIBLE=1 "$pi_bin" \
    --mode text --print --no-session --no-builtin-tools --no-skills --no-prompt-templates --no-themes --no-context-files \
    --provider mempalace-packaged-local --model scripted --api-key local-only \
    -e "$root/test/mempalace/fixtures/packaged-provider.ts" RUN_INCOMPATIBLE 2>&1)"
  incompatible_status=$?
  set -e
  # Pi's text renderer does not promise to serialize UI notifications to stdout.
  # The lifecycle suite asserts the exact actionable notice; this packaged run
  # proves Pi remains usable, dispatches no tool, and terminates the bad core.
  [[ $incompatible_status -eq 0 && "$incompatible_output" == *'PACKAGED_PROVIDER_PASS'*'"incompatible":true'* ]]
  assert_core_gone

  [[ ! -s "$network" ]] || { echo "routine non-loopback network attempted:" >&2; cat "$network" >&2; exit 1; }
  records_before="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).snapshot.totalDrawers))' "$baseline")"
  records_after="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).snapshot.totalDrawers))' "$final_evidence")"
  retained_percent=$(( records_before == 0 ? 100 : 100 * records_after / records_before ))
  (( retained_percent == 100 ))

  actual_platform="$(node -p 'process.platform')"
  actual_arch="$(node -p 'process.arch')"
  actual_node="$(node -p 'process.version')"
  [[ -z "${EXPECTED_PLATFORM:-}" || "$actual_platform" == "$EXPECTED_PLATFORM" ]]
  [[ -z "${EXPECTED_ARCH:-}" || "$actual_arch" == "$EXPECTED_ARCH" ]]
  if [[ -n "${EXPECTED_NODE_VERSION:-}" ]]; then
    [[ "$EXPECTED_NODE_VERSION" == '24.x' && "$actual_node" == v24.* || "$actual_node" == "v$EXPECTED_NODE_VERSION" ]]
  fi
  matrix_evidence="$(node -e 'process.stdout.write(JSON.stringify({candidateSha256:process.argv[1],sourceCommit:process.argv[2],sourceTree:process.argv[3],platform:process.argv[4],arch:process.argv[5],node:process.argv[6],pi:process.argv[7],core:process.argv[8],recordsBefore:Number(process.argv[9]),recordsAfter:Number(process.argv[10]),retainedPercent:Number(process.argv[11]),networkAttempts:0,syntheticPredecessor:true,lifecycle:["pi-install","pi-list","disable","pi-remove","zero-tools","reinstall","synthetic-predecessor","upgrade","rollback","current-restore","project-local-install","project-json-palace","restart","env-override","project-json-disabled","project-json-invalid","untrusted-json-unread","project-remove","project-reinstall"]}))' \
    "$candidate_sha" "$source_commit" "$source_tree" "$actual_platform" "$actual_arch" "$actual_node" "$PI_VERSION" "$version" "$records_before" "$records_after" "$retained_percent")"
  printf '%s\n' "$matrix_evidence"
  [[ -z "${MEMPALACE_MATRIX_EVIDENCE:-}" ]] || printf '%s\n' "$matrix_evidence" >> "$MEMPALACE_MATRIX_EVIDENCE"
  printf 'Packaged matrix: PASS Pi %s + MemPalace %s (install=%ss, records=%s/%s, network=0)\n' \
    "$PI_VERSION" "$version" "$install_seconds" "$records_before" "$records_after"
done

printf 'Packaged gate: PASS\n'
