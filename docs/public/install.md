# Install MemPalace for Pi

This is the pending support-floor installation path for the community `mempalace-for-pi` integration. MemPalace is the official, separately installed core; this Pi package is only the integration. Review both projects before installation because Pi extensions execute with the user's permissions.

## Pending candidate environment

The unreleased candidate requires macOS on arm64, Node `22.19.0` or `24.x`, Pi `0.84.2`, and MemPalace `3.9.0`. The two-cell `3.9.0` matrix is pending verification, so these values are a candidate contract rather than a verified support claim. Linux is not supported by the current package contract, and Windows remains outside scope.

The previous four-cell macOS matrix for MemPalace `3.6.0` and `3.7.1` remains unchanged in the repository evidence as historical migration context only. Do not use those old core versions with the current support-floor candidate.

The commands below install the pending core candidate and Pi `0.84.2`:

```bash
uv tool install --python 3.12 'mempalace==3.9.0'
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
mempalace --version
pi --version
```

Expected output is `MemPalace 3.9.0` and `0.84.2`; that output does not by itself verify the candidate. Existing users must update both MemPalace and `mempalace-for-pi` from the same approved source, then restart Pi:

```bash
uv tool install --python 3.12 'mempalace==3.9.0'
pi remove -l npm:mempalace-for-pi --approve
pi install -l npm:mempalace-for-pi --approve
```

Use the corresponding `git:github.com/NoahWTeng/mempalace-for-pi` source in both Pi commands when that is the source already approved for the project. Restart Pi after the update. Daily `palace_search`, `palace_save`, `palace_diary`, and `palace_status` behavior remains unchanged.

The integration installs from either npm (`npm:mempalace-for-pi`) or this repository (`git:github.com/NoahWTeng/mempalace-for-pi`):

```bash
pi install git:github.com/NoahWTeng/mempalace-for-pi
```

Both sources deliver one artifact: the release process pins a packed candidate by SHA-256, and the exact tarball is what npm serves when a release is authorized. Only the transport differs, so pick whichever your project's review policy prefers — installing from Git lets you read the source you are about to run. No release or publication is implied by this pending candidate.

## Install into one project

The setup is project-local. It records the package in the project's own `.pi/settings.json` instead of the user account, so a project carries both its integration and its memory settings, and a second computer needs no repeat of an export:

```bash
cd /path/to/your/project
mkdir -p .pi
cat > .pi/mempalace.json <<'JSON'
{
  "version": 1,
  "palace": "~/palaces/your-project"
}
JSON
pi install -l npm:mempalace-for-pi --approve
pi list --approve
```

A project-local install writes project configuration, so Pi asks you to trust the project folder first. `--approve` states that decision for one command; answering "Trust" once in the interactive prompt records it for later runs. An untrusted project loads no project package and reads no `.pi/mempalace.json` at all.

Both files belong in version control. `.pi/settings.json` records which reviewed source the project uses, and `.pi/mempalace.json` records where the palace lives — written with `~/`, so it resolves on every machine. Every setting is re-read at each start, so a change to either file needs only a restart of Pi.

## Start locally

The official core's default backend can provision local model assets on first use. Finish that provisioning before enforcing an offline environment. The candidate path uses the core's local `sqlite_exact` backend:

```bash
export MEMPALACE_BACKEND=sqlite_exact
export MEMPALACE_BACKEND_EXPLICIT=sqlite_exact
pi --approve
```

On the first memory operation, the integration automatically starts a per-palace MemPalace Hub on loopback when no healthy writable registration exists. Later calls and later Pi sessions reuse that Hub when it is healthy. The upstream Hub may exit when idle; that is not palace deletion, and the next operation starts or reuses the loopback Hub again. Palace data persists across Pi sessions because the official core owns the palace on disk.

In Pi, first ask: “Use `palace_status` and report whether this project palace is operational.” Then exercise all four tools with non-sensitive synthetic content:

1. Ask `palace_save` to store a small project finding with an explicit wing and room.
2. Ask `palace_search` to retrieve that finding.
3. Ask `palace_diary` to write and then read a short diary entry.
4. Ask `palace_status` again.

If status reports a missing or incompatible core, or the Hub cannot start, stop and follow [troubleshooting](troubleshooting.md). Update both components and restart Pi before retrying. For palace selection and safety controls, continue with [configuration](configuration.md). Removing or disabling the integration never removes palace data; see [migration](migration.md).

Sources: [official MemPalace repository](https://github.com/MemPalace/mempalace) and [Pi package documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md).
