# Migration provenance

This repository is being converted into a community Pi integration for the
official MemPalace core. The public integration under `integration/` is a
selective migration of a private, internally developed Pi extension. This
document records what that source is, who owns it, under which licence it may be
redistributed, and what is deliberately excluded — before any production source
is copied.

The source project is a private repository belonging to the same author and is
deliberately not named here. Naming it would publish the location of unpublished
private work while adding nothing the licence grant depends on: the author below
is its sole copyright holder, so the evidence that matters is authorship, the
frozen snapshot, and the per-file digests, all recorded in full.

## Source snapshot

| Field | Value |
| --- | --- |
| Source project | private, unpublished; sole author Noah W. Teng |
| Snapshot commit | `1e7819cf4b48ba30aca577273138dde9387191f6` |
| Snapshot subject | `fix(task-maker): state the regression rule so it holds outside this repo` |
| Destination | this repository, `integration/**` |

The snapshot commit is the single frozen reference for the migration. Paths below
are relative to the source extension's own root. Digests are of the file contents
**at that commit**, so they stay valid however the source project evolves
afterwards, and they identify the exact bytes migrated without depending on where
those bytes lived.

## Authorship and licence evidence

- Every commit touching the source extension up to and including the snapshot was
  authored by `NoahWTeng <58103983+NoahWTeng@users.noreply.github.com>` — 4
  commits, from `4c9fa93` (2026-07-16, extension introduced) to `4ac3ddc`
  (2026-08-17). There is no third-party contribution to relicense.
- The source extension's `package.json` at the snapshot declares
  `"author": "Noah W. Teng"` and `"license": "MIT"`. The package is marked
  `"private": true`, which withholds npm publication, not redistribution rights.
- The source repository carries **no repository-level `LICENSE` file** at the
  snapshot; the MIT grant above is declared per package in the extension's own
  manifest. The same copyright holder authorises this migration, so the MIT terms
  are restated in this repository's `LICENSE` alongside the existing Pi Mnesia
  copyright line.
- This repository is MIT licensed (`LICENSE`, added 2026-08-14 in `67afad4`),
  so the migrated files keep a compatible licence and require no relicensing.

## Imported source inventory

These are the exact files that may be migrated from the snapshot. Nothing
outside this list is imported. Migration happens in later tasks; the digests
pin what "the proven source" means.

| Source file (at snapshot) | Lines | SHA-256 | Destination |
| --- | --- | --- | --- |
| `src/mcp-client.ts` | 386 | `7fba7a78a699b3e339edb5d99a6056ca602d61e3d53acf4da9b3483d1579a867` | `integration/mcp-client.ts` |
| `src/resolve.ts` | 335 | `7e589a4119c0a1beca95b595905b749b1cc64d15ee9afd89f8d9c876fa0a28df` | `integration/resolve.ts`, `integration/project-identity.ts` |
| `src/wakeup.ts` | 159 | `93842dd39b6b831f28622067438c71aad66fa545dbb02e62ff2f245ab08f91c2` | `integration/wakeup.ts` |
| `src/tools.ts` | 126 | `5c5a0d41297e366f78eb8bd7df8dc4109b53e4d2c0e613b93142e28da9572ce9` | `integration/tools.ts`, `integration/safety.ts` |
| `src/extension.ts` | 151 | `9020d2bd74f76d9689fffccb5dcc10a277c1802fcd3f04671bf7cdb9c9bcb7d9` | `integration/extension.ts`, `integration/lifecycle.ts` |
| `src/index.ts` | 10 | `08dad2f100598dd384146463f67c10786a2f7cbc6e8d583143c8f7bacff6d5ae` | `integration/index.ts` |
| `src/compact-handoff.ts` | 140 | `5969ead557ff8a03014f572e5b857f341bee2f5edda8ab98993a7de5c5f22310` | `integration/compact-handoff.ts` |

Regression sources that may be adapted into `test/mempalace/**`:

| Source file (at snapshot) | Lines | SHA-256 |
| --- | --- | --- |
| `tests/fixtures/fake-mempalace-server.mjs` | 96 | `f87d01175c6dc1073dcd69d721b00b45003b4a143b0163a6048a18114847f276` |
| `tests/unit/mcp-client.test.ts` | 406 | `0371283e9ba78165f53d874d946acbd8da48e4ace102f0e944eae91e5bac7774` |
| `tests/unit/mcp-client-integration.test.ts` | 65 | `b19ab396fbcf7cacba6f47d526e3f0df2e60dca9ecd70fe7f5746996ee701e30` |
| `tests/unit/resolve.test.ts` | 468 | `5708fe65047e9b8dd108d150fe8bd8cbe8ffe797520f434ea355d0784e33ef6b` |
| `tests/unit/wakeup.test.ts` | 264 | `4d6fbbe8a96ae13814ead9c645385c446c2295e7066ac90489318039906dfe3a` |
| `tests/unit/tools.test.ts` | 199 | `d34a9b6aba2d68bbf739b503c514d0d865a717ad9c966f335a7d1d886806a083` |
| `tests/unit/extension.test.ts` | 295 | `71c04b59953e3e444baadc1d9635e6d59de116ccea71df5a0faf81cc94b01514` |
| `tests/unit/compact-handoff.test.ts` | 219 | `d3efda284afa4f2b87e381e0d217559ecfbbfa5df3423becc4bc35db389e9441` |

## Exclusions

| Excluded source | Reason |
| --- | --- |
| `src/command.ts` | The public integration exposes four `palace_*` tools and no `/palace` slash command. |
| `tests/unit/run-evals-env.test.ts` | Covers an internal eval switch that does not exist in the public integration. |
| `package.json` | Private internal manifest; the public identity is declared in this repository's `package.json`. |
| `tsconfig.json`, `.gitignore` | Internal build configuration; this repository has its own. |
| `README.md` | Internal documentation specific to the private repository; public documentation is written fresh in `docs/public/`. |

Internal assumptions carried by the excluded and imported files — private
workspace-configuration discovery, an internal eval switch, private checkout
discovery, and the non-serving `mempalace mcp` fallback — are removed during
migration, not copied. `scripts/check-public-repository.mjs` scans every tracked
file and fails the build if any of those internal identifiers reappears.

## MemPalace core is not copied

MemPalace core is not copied, vendored, forked, or reimplemented by this
package. The integration launches the separately installed official
`mempalace-mcp` executable over stdio, and MemPalace owns all durable storage.

- Upstream: <https://github.com/MemPalace/mempalace>, MIT licensed,
  Copyright (c) 2026 MemPalace Contributors.
- Verified local baseline: `3.6.0` (`pyproject.toml`, `requires-python = ">=3.9"`,
  running on Python 3.12 locally).
- Current public release targeted for verification: `3.7.1` (upstream tag
  `v3.7.1`, `359c579d2028fd5f4964984297abf67417e7c105`).

No MemPalace source file appears in the imported inventory above, and no
MemPalace file is present in this repository.

## Package status

`package.json` stays `"private": true`. The name `mempalace-for-pi` replaced an
earlier provisional scoped name because ownership of that npm scope was never
held. The unscoped name is unclaimed on the registry rather than
reserved, and no npm publication, Git tag, or announcement is authorised by this
work. The GitHub repository was renamed to `NoahWTeng/mempalace-for-pi` under
explicit maintainer authorisation.
