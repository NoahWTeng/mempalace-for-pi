#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 1 ]]; then
  echo 'usage: bash scripts/gate-explorer-task.sh <1-5>' >&2
  exit 2
fi

task="$1"
artifacts=()
tests=()

case "$task" in
  1)
    artifacts=(
      integration/explorer/adapter.ts
      integration/safety.ts
      scripts/gate-explorer-task.sh
      test/mempalace/explorer-adapter.test.ts
      test/mempalace/fixtures/fake-mempalace-server.mjs
    )
    tests=(test/mempalace/explorer-adapter.test.ts)
    ;;
  2)
    artifacts=(
      integration/explorer/server.ts
      integration/explorer/command.ts
      test/mempalace/explorer-server.test.ts
    )
    tests=(
      test/mempalace/explorer-server.test.ts
      test/mempalace/extension.test.ts
    )
    ;;
  3)
    artifacts=(
      integration/explorer/assets/index.html
      integration/explorer/assets/model.js
      integration/explorer/assets/app.js
      integration/explorer/assets/styles.css
      test/mempalace/explorer-ui.test.mjs
    )
    tests=(test/mempalace/explorer-ui.test.mjs)
    ;;
  4)
    artifacts=(
      integration/explorer/assets/model.js
      integration/explorer/assets/app.js
      integration/explorer/assets/styles.css
      test/mempalace/explorer-ui.test.mjs
    )
    tests=(test/mempalace/explorer-ui.test.mjs)
    ;;
  5)
    artifacts=(
      scripts/acceptance-explorer.mjs
      test/mempalace/fixtures/explorer-study.json
      docs/public/memory-explorer.md
    )
    tests=(test/mempalace/public-docs.test.mjs)
    ;;
  *)
    echo "unknown explorer task: $task" >&2
    exit 2
    ;;
esac

for required in "${artifacts[@]}"; do
  [[ -e "$required" ]] || {
    echo "missing Task $task artifact: $required" >&2
    exit 1
  }
done

node --test --test-concurrency=1 --experimental-strip-types "${tests[@]}"

if [[ "$task" == 5 ]]; then
  npm run test:package-boundary
  npm run test:packaged
  npm run test:explorer -- --study test/mempalace/fixtures/explorer-study.json
  browser="${EXPLORER_BROWSER:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
  [[ -x "$browser" ]] || {
    echo "explorer browser is not executable: $browser" >&2
    exit 1
  }
  npm run test:explorer -- --browser "$browser"
fi

bash scripts/gate-project-config-pre-attestation.sh
printf 'Explorer gate: PASS (task %s)\n' "$task"
