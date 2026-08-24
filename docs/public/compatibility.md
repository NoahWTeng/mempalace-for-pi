# Compatibility

Support is limited to the following green matrix. One SHA-bound packed candidate was installed and exercised in every cell. Each cell used Pi's package lifecycle, a project-local install driven by `.pi/mempalace.json`, official MemPalace, the four public tools, guarded offline routine operations, exact palace snapshots through lifecycle transitions, and five-second process cleanup.

| Platform | Architecture | Node | Pi | MemPalace | Result |
| --- | --- | --- | --- | --- | --- |
| darwin | arm64 | 22.19.0 | 0.84.2 | 3.6.0 | PASS |
| darwin | arm64 | 22.19.0 | 0.84.2 | 3.7.1 | PASS |
| darwin | arm64 | 24.x | 0.84.2 | 3.6.0 | PASS |
| darwin | arm64 | 24.x | 0.84.2 | 3.7.1 | PASS |
| linux | arm64 | 22.19.0 | 0.84.2 | 3.6.0 | PASS |
| linux | arm64 | 22.19.0 | 0.84.2 | 3.7.1 | PASS |
| linux | arm64 | 24.x | 0.84.2 | 3.6.0 | PASS |
| linux | arm64 | 24.x | 0.84.2 | 3.7.1 | PASS |

The candidate also used Python `3.12` to run the official core, Pi `0.84.2`, and the installed `mempalace-for-pi` package. All cells reported `PASS`, exact 5/5 retained drawers, 100% retention, zero guarded non-loopback attempts during routine operations after provisioning, process cleanup within five seconds, and a byte-distinct synthetic predecessor lifecycle.

Every cell additionally exercised the project document end to end: a project-local install, a palace declared by `.pi/mempalace.json`, a restart that found the same records, an environment override that left the declared palace untouched, a disabling document and each refused document class exposing no tool and starting no process, an untrusted run that never read the document, and a project-local removal and reinstall that reconnected the same palace.

The recorded evidence for each cell — the candidate SHA-256, the source commit and tree, and every measured field above — is `.github/verification/task-967-matrix.json`. It is written from real gate output and is bound to one immutable commit; a change to any packed file invalidates it until the candidate is attested again.

This table is exhaustive, not a minimum-version range. Other platforms, architectures, Node releases, Pi releases, and MemPalace releases are unverified and receive no support claim.

See [install](install.md), [privacy](privacy.md), and [troubleshooting](troubleshooting.md).
