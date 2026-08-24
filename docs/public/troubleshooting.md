# Troubleshooting

The integration fails inert so Pi remains usable. Start with `palace_status` when the tool is present; otherwise use the startup warning and the checks below.

## Core is missing

A warning stating that MemPalace is unavailable means `mempalace-mcp` was not executable on Pi's `PATH` and no usable `MEMPALACE_DIR` checkout was configured.

```bash
mempalace --version
command -v mempalace-mcp
```

Reinstall the official core using [install](install.md), or set `MEMPALACE_DIR` to a reviewed official checkout. Restart Pi after changing the environment.

## Unsupported version

Only MemPalace `3.6.0` and `3.7.1` are accepted. An unsupported version warning leaves the integration inert and terminates the rejected core process. Install one exact tested version; do not bypass negotiation. Check the full [compatibility matrix](compatibility.md).

## The project document was refused

A warning that MemPalace could not use `.pi/mempalace.json` means the document exists but does not satisfy the contract, so the integration refused it as a whole: zero palace tools are registered, no core process starts, and the palace is not touched. The message names the offending declaration and never prints a resolved path.

The document must be a JSON object declaring `"version": 1`, plus any of `palace`, `readOnly`, `handoff`, and `disabled`. Text that is not JSON, an array, a missing or different `version`, an unknown key, and a value of the wrong type are each refused. Correct or remove the document and restart Pi; see [configuration](configuration.md) for the exact contract.

## The project is untrusted

An untrusted project loads no project-local package and its `.pi/mempalace.json` is never read, so no palace tool appears and any setting the document declares — including a declared palace — is ignored. This is the fail-closed default: a checkout you have not approved cannot make Pi execute or configure anything.

Approve the project folder once in Pi's trust prompt, or state the decision for one command:

```bash
pi --approve
```

Use `--no-approve` to run the same project deliberately untrusted. Trust is a decision about the folder, not about this package: it also governs project extensions, skills, and settings.

## Palace or permission failure

Confirm `MEMPALACE_PALACE` names the intended existing directory and that the current user can traverse its parents and read its contents. Do not solve a permission error with broad world-writable permissions. Stop other writers before changing ownership or restoring a backup. The public status intentionally does not print the raw path.

## Timeout or malformed output

Wake-up aborts after 10 seconds; MCP requests have bounded timeouts. Pi continues without the failed snapshot or operation. A read may reconnect and retry once. A write whose result is uncertain is never automatically repeated: search/status first, confirm whether it landed, then decide manually. Repeated errors require a Pi restart and core log review, not blind write retries.

## Read-only or non-retention refusal

`MEMPALACE_READ_ONLY=1` blocks save, diary write, and handoff while reads continue. Remove it only for an intentional write. `retain:false`, a first-line `[no-memory]`, or credential-shaped data refuses the whole candidate with no partial redaction.

## Process cleanup

On Pi shutdown or rejected-core negotiation, the integration owns cleanup of the MCP process group, descendants, stdio, handles, and pending requests within five seconds. After Pi exits, inspect rather than killing blindly:

```bash
pgrep -fl mempalace-mcp
```

No package-owned process should remain. If one remains, do not start another writer: capture diagnostics, terminate it using your operating system's normal process controls, verify the palace, and restart Pi. Persistent survivors block release support.

## Recover from inert mode

1. Exit Pi.
2. Correct the core version, executable path, palace permission, or configuration.
3. Confirm `MEMPALACE_BRIDGE_DISABLE` is not `1`.
4. Restart Pi and ask for `palace_status`.

Do not delete or move palace data as an inert-mode recovery step. Disable/remove/reinstall instructions are in [migration](migration.md).
