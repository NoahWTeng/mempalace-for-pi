# Changelog

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
