# Migration and package lifecycle

The integration lifecycle and palace lifecycle are separate. Every procedure here changes only Pi package/configuration state. It never moves or deletes palace data. Back up palace data with the official core's procedure before changing versions or paths.

## From a private bridge

A retained palace is reconnected, never moved. The cutover needs no account, no sign-in, and no stored secret of any kind: it is a path and a restart.

1. Stop every Pi/private-bridge session using the palace and wait for its core process to exit.
2. Do not copy, rename, merge, or delete the palace.
3. Install the community package using [the project-local procedure](install.md).
4. Record the retained location in the project document, `.pi/mempalace.json`:

```json
{
  "version": 1,
  "palace": "~/.mempalace/existing-project-palace"
}
```

1. Start Pi in the project and approve the project folder once:

```bash
pi --approve
```

1. Use `palace_status`, search a known synthetic-safe record, and read a diary entry before writing anything.

The declared location reconnects in place, and the acceptance matrix compared exact record IDs, content, diary content, and palace identity across the cutover — not counts alone. Official MemPalace remains responsible for any palace-format migration.

For a single machine or one launch, the environment override still wins over the document:

```bash
export MEMPALACE_PALACE="$HOME/.mempalace/existing-project-palace"
pi --approve
```

## Disable

For one launch, use:

```bash
MEMPALACE_BRIDGE_DISABLE=1 pi
```

For a project-wide disable that travels with the repository, declare it in `.pi/mempalace.json`:

```json
{
  "version": 1,
  "disabled": true
}
```

For a persistent Pi resource disable, run `pi config`, choose the installed Git package, disable its extension, then restart Pi:

```bash
pi config
```

The verified disabled journey exposed zero palace tools, started no core process, and left an exact byte digest of the palace unchanged.

## Remove and reinstall

Remove only the Pi package:

```bash
pi remove git:github.com/NoahWTeng/mempalace-for-pi
pi list
```

Removing a project-local install instead removes it only from that project:

```bash
pi remove -l git:github.com/NoahWTeng/mempalace-for-pi --approve
pi list --approve
```

Reinstall from the reviewed Git source and reconnect the same palace:

```bash
pi install git:github.com/NoahWTeng/mempalace-for-pi
export MEMPALACE_PALACE="$HOME/.mempalace/existing-project-palace"
pi
```

A project keeps its `.pi/mempalace.json` through removal, so a project-local reinstall reconnects the declared palace with no further step.

Removal does not imply data deletion. Delete palace data only with a separate, explicit destructive core procedure after backup; this integration provides no delete-on-uninstall path.

## Upgrade, rollback, and current restore

The user rollback unit is a reviewed Git commit. Remove the currently configured source before installing its pinned replacement, then verify the retained palace:

```bash
CURRENT_SOURCE=git:github.com/NoahWTeng/mempalace-for-pi
KNOWN_GOOD_COMMIT=4eed0912920ec631697b77b48b4157719fc00fbc
PINNED_SOURCE="git:github.com/NoahWTeng/mempalace-for-pi@$KNOWN_GOOD_COMMIT"
pi remove "$CURRENT_SOURCE"
pi install "$PINNED_SOURCE"
```

Restore the current reviewed Git head with the same remove-then-install transition:

```bash
pi remove "$PINNED_SOURCE"
pi install "$CURRENT_SOURCE"
```

`pi install` adds a source; it does not replace another source with the same package name. If `pi list` reports a different installed source string, remove that exact source instead.

The release matrix separately exercised an explicitly synthetic predecessor: a byte-distinct, private test artifact labelled `0.0.9`, not a historical or public release. Its exact sequence was synthetic predecessor install → current upgrade → synthetic rollback → current restore. At every phase, acceptance compared record IDs, content, diary content, and palace identity—not only counts—and observed 100% retention. Do not seek or install that synthetic predecessor; it exists only as rollback evidence.

If a core upgrade requires palace migration, follow the official MemPalace release procedure. Never use package removal as a palace rollback mechanism. See [troubleshooting](troubleshooting.md) before retrying a failed transition.
