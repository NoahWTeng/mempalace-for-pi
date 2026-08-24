# Contributing

This file is deliberately not part of the published package. `package.json#files`
ships only what an installer needs, and every file it ships is covered by the
SHA-256 the compatibility matrix attests. Editing a packed file — `README.md`,
`LICENSE`, `CHANGELOG.md`, `MIGRATION_PROVENANCE.md`, `docs/public/`,
`integration/` — changes what `npm pack` produces and invalidates that evidence
until the matrix is run again. Contributor documentation has no reason to carry
that cost, so it lives here.

## Working locally

```bash
npm ci
npm test                 # the whole suite
npm run check            # types
npm run check:repository # the public-tree boundary
```

`npm run release:check` runs the packaged release gate against a locally packed
candidate. It installs a real MemPalace core, so it is slower and needs `uv` on
the path.

## What CI runs

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` → `quick` | every push and pull request | Types, the full suite, and the repository boundary. This is the check that blocks a merge. |
| `ci.yml` → `candidate` | push to `main`, manual | Packs the candidate, asserts the tree is clean and matches the commit, and uploads the tarball. |
| `ci.yml` → `macos-arm64`, `linux-arm64` | manual only | The eight-cell compatibility matrix. Each cell installs a real core, drives Pi's whole package lifecycle, and uploads the record it measured. |
| `ci.yml` → `matrix-evidence` | manual only | Joins the per-cell records into `task-967-matrix.json` and publishes it as an artifact. |
| `release.yml` | pushing a `v*` tag | Verifies, publishes to npm with provenance, and opens the GitHub release. |

Every job runs on a GitHub-hosted runner. That is not incidental:
`scripts/gate-ci.sh` fails if any workflow declares a self-hosted runner, because
fork pull requests are validated here and a fork's code must never reach a
maintainer's machine. It is also what makes npm provenance possible at all — npm
refuses to attest a build from a self-hosted runner.

## Cutting a release

The matrix pins one packed candidate by SHA-256, and the suite refuses to call a
pairing verified unless that digest still matches what `npm pack` produces. So a
release is only possible when the attested evidence describes the exact tree
being tagged.

1. **Land the change.** Any edit to a packed file invalidates the current matrix;
   `npm test` will say so.
2. **Re-attest.** Run the CI workflow manually (`workflow_dispatch`). The job
   summary reports whether the committed evidence is current; when it is stale,
   download the aggregate and commit it:

   ```bash
   # `gh run download` will not overwrite an existing file, and refreshing always
   # means one exists, so land it in a temporary directory and move it into place.
   tmp="$(mktemp -d)"
   gh run download <run-id> --name task-967-matrix --dir "$tmp"
   mv "$tmp/task-967-matrix.json" .github/verification/
   rm -rf "$tmp"
   ```

   CI never commits it itself. Doing so would need `contents: write` in a
   workflow that also runs fork pull requests, and the aggregator is the only
   thing that writes that file — every field in it is copied from a record a
   real gate run produced, and it refuses to write at all unless the records are
   complete, agree on one candidate, and cover the declared support surface.
3. **Bump and tag.**

   ```bash
   npm version patch      # updates package.json, package-lock.json, and tags
   git push --follow-tags
   ```

The tag drives the rest. `release.yml` re-runs the gates, checks the tag against
`package.json`, refuses to publish unless `npm pack` reproduces the attested
digest, then publishes with a
[provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
and opens the GitHub release.

Publishing needs an `NPM_TOKEN` repository secret — an npm automation token, or a
granular token scoped to write this one package. Without it the publish job stops
with an explicit message rather than failing obscurely.

Version numbers are chosen by hand. One package and one maintainer do not need a
release-automation tool to decide what `npm version patch` already decides.

## Reporting a security issue

Do not open a public issue for a vulnerability. Report it privately through
[GitHub's security advisories](https://github.com/NoahWTeng/mempalace-for-pi/security/advisories/new).

MemPalace itself is a separate upstream project; issues in the core belong in
[its repository](https://github.com/MemPalace/mempalace), not this one.
