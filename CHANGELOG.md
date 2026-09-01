# Changelog

## [Unreleased]

Adds the first prompt template, so declaring a project's memory no longer has to be transcribed by hand.

### Added

- `/mempalace-init [palace-path]`, a packaged prompt template that writes `.pi/mempalace.json` with `version: 1` and a `~/`-form palace, derived from the project directory name when no argument is given. It reports and stops when a declaration already exists rather than replacing it, because the existing document points at memory already written.
- `prompts/` is now part of the packaged file list and is declared through `pi.prompts`. The packed boundary test asserts that entry and the packed prompt path, so the new surface cannot widen unnoticed.

### Release gate

- Packing this change alters the candidate digest, so [`task-967-matrix.json`](.github/verification/task-967-matrix.json) no longer binds the artifact it attests. The eight-cell matrix has to be re-run and the evidence regenerated before a pairing may claim verification again; the version stays `0.1.1` until that release act assigns the next one.

### Unchanged

- The tool surface is still exactly `palace_search`, `palace_save`, `palace_diary`, and `palace_status`. A prompt template is Markdown that expands into a prompt; it registers no tool, starts no process, and reaches no network.
- The support claim is untouched. [Public compatibility documentation](docs/public/compatibility.md) remains the exhaustive green matrix, and the verified pairings still declare Pi `0.84.2` alone.

## [0.1.1] - 2026-08-24

Widens the Pi peer range so a Pi minor release cannot refuse the install.

### Fixed

- `peerDependencies` on `@earendil-works/pi-coding-agent` is now `>=0.84.2 <1.0.0`, previously `>=0.84.2 <0.85.0`. The old upper bound would have refused installation on the first Pi `0.85` release. Nothing in the integration resolves Pi at run time — every import of the package is `import type`, so the types are erased and Pi hands the extension its API at load — which means an upper bound cannot prevent a runtime incompatibility, only an install. The major boundary still applies, where a breaking change is deliberately signalled.

### Unchanged

- The support claim is untouched. [Public compatibility documentation](docs/public/compatibility.md) remains the exhaustive green matrix, and the verified pairings still declare Pi `0.84.2` alone. Every other Pi release is unverified and carries no support claim; a wider install range is not a wider tested surface.

## [0.1.0] - 2026-08-24

First public release of the community integration, published to npm as `mempalace-for-pi` and tagged `v0.1.0`.

### Added

- Community-maintained `mempalace-for-pi` integration for the separately installed official MemPalace core.
- Exactly four public tools: `palace_search`, `palace_save`, `palace_diary`, and `palace_status`.
- One bounded inert wake-up snapshot per session, project/worktree identity, explicit existing-palace selection, read-only mode, and opt-in mechanical compaction handoff.
- One whole-candidate write gate for credential-shaped data, `retain:false`, first-line `[no-memory]`, read-only mode, and bounded content.
- Git/Pi installation, configuration, privacy, migration, troubleshooting, and exact compatibility documentation.
- One SHA-bound eight-cell macOS/Linux arm64 matrix across Node `22.19.0`/`24.x`, Pi `0.84.2`, and MemPalace `3.6.0`/`3.7.1`, including guarded local routine operations and exact palace retention through disable/remove/reinstall/synthetic rollback/current restore.

### Support boundary

- MemPalace remains a separate official prerequisite and the sole owner of durable palace storage and schema migration.
- The integration and tested local core path require no routine non-loopback network access after provisioning; Pi's configured model provider is outside this guarantee.
- The repository and package contain only the current MemPalace integration; retired Pi Mnesia runtime and benchmark trees are excluded.
- Support is limited to the exact green matrix in [public compatibility documentation](docs/public/compatibility.md).

### Release authorization

The owner checkpoint this release was gated on is complete. The packed file list and SHA, the eight-cell evidence, the standalone-clone gates, and the security boundary were reviewed, and the owner authorized publication, tagging, and the change to public visibility.

The repository history was replaced with a single initial commit at that point. Development happened in a private tree whose planning documents, benchmarks, and predecessor references were never intended for publication; squashing publishes the reviewed result without them. The pre-publication history is retained privately and is not required to build, verify, or audit this release — [`MIGRATION_PROVENANCE.md`](MIGRATION_PROVENANCE.md) carries the authorship evidence, and the compatibility matrix pins the candidate by digest.
