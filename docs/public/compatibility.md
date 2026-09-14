# Compatibility

MemPalace `3.9.0` is the verified support contract for the automatic loopback Hub on macOS arm64. It has exactly two cells: Node `22.19.0` and `24.x`, each with Pi `0.84.2` and MemPalace `3.9.0`. One SHA-bound packed candidate produced PASS evidence in both cells.

| Platform | Architecture | Node | Pi | MemPalace | Result |
| --- | --- | --- | --- | --- | --- |
| darwin | arm64 | 22.19.0 | 0.84.2 | 3.9.0 | PASS |
| darwin | arm64 | 24.x | 0.84.2 | 3.9.0 | PASS |

## Historical migration evidence

The four PASS cells below are retained from the previous candidate for MemPalace `3.6.0` and `3.7.1`. They are historical migration context, not the current support floor:

| Platform | Architecture | Node | Pi | MemPalace | Result |
| --- | --- | --- | --- | --- | --- |
| darwin | arm64 | 22.19.0 | 0.84.2 | 3.6.0 | PASS |
| darwin | arm64 | 22.19.0 | 0.84.2 | 3.7.1 | PASS |
| darwin | arm64 | 24.x | 0.84.2 | 3.6.0 | PASS |
| darwin | arm64 | 24.x | 0.84.2 | 3.7.1 | PASS |

The historical candidate used Python `3.12` to run the official core, Pi `0.84.2`, and the installed `mempalace-for-pi` package. All four cells reported PASS, exact 5/5 retained drawers, 100% retention, zero guarded non-loopback attempts during routine operations after provisioning, process cleanup within five seconds, and a byte-distinct synthetic predecessor lifecycle. The historical evidence remains migration context in repository history.

Every historical cell additionally exercised the project document end to end: a project-local install, a palace declared by `.pi/mempalace.json`, a restart that found the same records, an environment override that left the declared palace untouched, a disabling document and each refused document class exposing no tool and starting no process, an untrusted run that never read the document, and a project-local removal and reinstall that reconnected the same palace.

The recorded evidence for the verified cells — the candidate SHA-256, the source commit and tree, and every measured field above — is `.github/verification/task-967-matrix.json`. It is written from real gate output and is bound to the measured source commit; changing a packed file makes it stale rather than turning it into evidence for another candidate.

The verified two-cell candidate exercised automatic loopback Hub startup and reuse, persistence across Pi sessions, and the upstream Hub's idle exit behavior. Other platforms, architectures, Node releases, Pi releases, and MemPalace releases are unverified and receive no support claim.

See [install](install.md), [privacy](privacy.md), and [troubleshooting](troubleshooting.md).
