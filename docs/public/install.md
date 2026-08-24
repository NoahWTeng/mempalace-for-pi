# Install MemPalace for Pi

This is the tested community installation path for `mempalace-for-pi`. MemPalace is the official, separately installed core; this Pi package is only the integration. Review both projects before installation because Pi extensions execute with the user's permissions.

## Verified environment

Use only a combination listed in [compatibility](compatibility.md): macOS or Linux on arm64, Node `22.19.0` or `24.x`, Pi `0.84.2`, and MemPalace `3.6.0` or `3.7.1`. The clean matrix completed core and integration installation in under ten minutes per cell.

The commands below choose MemPalace `3.7.1`. They follow the official core's isolated `uv tool` recommendation and Pi `0.84.2` Git-package syntax:

```bash
uv tool install --python 3.12 'mempalace==3.7.1'
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
mempalace --version
pi --version
pi install git:github.com/NoahWTeng/mempalace-for-pi
pi list
```

Expected version output is `MemPalace 3.7.1` and `0.84.2`. `pi list` must show `mempalace-for-pi`. To use the other tested core, change only the first command to:

```bash
uv tool install --python 3.12 'mempalace==3.6.0'
```

The integration installs from either npm (`npm:mempalace-for-pi`) or this repository (`git:github.com/NoahWTeng/mempalace-for-pi`). Both deliver one artifact: the compatibility matrix pins a packed candidate by SHA-256, and that exact tarball is what npm serves and what the `v0.1.0` tag builds. Only the transport differs, so pick whichever your project's review policy prefers — installing from Git lets you read the source you are about to run.

## Install into one project

The verified setup is project-local. It records the package in the project's own `.pi/settings.json` instead of the user account, so a project carries both its integration and its memory settings, and a second computer needs no repeat of any export:

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

See [configuration](configuration.md) for the exact document contract and the per-field precedence between the environment and the document.

## Start locally

The official core's default backend can provision local model assets on first use. Finish that provisioning before enforcing an offline environment. The release matrix used the core's local `sqlite_exact` backend:

```bash
export MEMPALACE_BACKEND=sqlite_exact
export MEMPALACE_BACKEND_EXPLICIT=sqlite_exact
pi --approve
```

In Pi, first ask: “Use `palace_status` and report whether this project palace is operational.” Then exercise all four tools with non-sensitive synthetic content:

1. Ask `palace_save` to store a small project finding with an explicit wing and room.
2. Ask `palace_search` to retrieve that finding.
3. Ask `palace_diary` to write and then read a short diary entry.
4. Ask `palace_status` again.

If status reports missing or incompatible core, stop and follow [troubleshooting](troubleshooting.md). For palace selection and safety controls, continue with [configuration](configuration.md). Removing or disabling the integration never removes palace data; see [migration](migration.md).

Sources: [official MemPalace repository](https://github.com/MemPalace/mempalace) and [Pi package documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md).
