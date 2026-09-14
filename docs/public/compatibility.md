# Compatibility

MemPalace `3.9.0` is the verified support contract for the automatic loopback Hub on macOS arm64. It has exactly two cells: Node `22.19.0` and `24.x`, each with Pi `0.84.2` and MemPalace `3.9.0`. One SHA-bound packed candidate produced PASS evidence in both cells.

| Platform | Architecture | Node | Pi | MemPalace | Result |
| --- | --- | --- | --- | --- | --- |
| darwin | arm64 | 22.19.0 | 0.84.2 | 3.9.0 | PASS |
| darwin | arm64 | 24.x | 0.84.2 | 3.9.0 | PASS |

Each current cell's migration journey retained 5/5 records (100% retention), made zero guarded non-loopback attempts during routine operations, and completed bounded process cleanup. The migration-specific fields and lifecycle phases are recorded in the matrix evidence below.

## Historical migration context

MemPalace `3.6.0` and `3.7.1` were used in earlier migration exercises. Those exercises are not part of the current support evidence, and this page makes no historical PASS claim for them.

The recorded evidence for the verified cells — the candidate SHA-256, source commit and tree, migration retention fields, and lifecycle — is `.github/verification/task-967-matrix.json`. It is written from real gate output and is bound to the measured source commit; changing a packed file makes it stale rather than turning it into evidence for another candidate.

The verified two-cell candidate exercised automatic loopback Hub startup and reuse, persistence across Pi sessions, and the upstream Hub's idle exit behavior. Other platforms, architectures, Node releases, Pi releases, and MemPalace releases are unverified and receive no support claim.

See [install](install.md), [privacy](privacy.md), and [troubleshooting](troubleshooting.md).
