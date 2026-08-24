// Tested-version declarations for the community MemPalace integration.
//
// Every value here is a support claim. A claim is only allowed once the Task 6
// acceptance matrix exercises it. No environment is listed that the project
// does not build for. Windows is
// deliberately absent: it is untested.

/** Whether the Task 6 acceptance matrix has exercised a declared pairing. */
export type VerificationState = 'pending' | 'verified';

export interface CompatibilityPairing {
  readonly pi: string;
  readonly mempalace: string;
  readonly verification: VerificationState;
}

/**
 * Pi releases the acceptance matrix actually exercised. This is the support
 * claim, not the install gate: the `package.json` peer range is deliberately
 * wider so a Pi minor release cannot block installation, and every Pi version
 * outside this list is unverified and unsupported.
 */
export const SUPPORTED_PI_VERSIONS = ['0.84.2'] as const;

/**
 * MemPalace core versions targeted for verification: `3.6.0` is the locally
 * verified baseline, `3.7.1` the current public release.
 */
export const SUPPORTED_MEMPALACE_VERSIONS = ['3.6.0', '3.7.1'] as const;

/** Node versions already covered by `.github/workflows/ci.yml`. */
export const SUPPORTED_NODE_VERSIONS = ['22.19.0', '24.x'] as const;

/** Python interpreter the verified MemPalace baseline runs on. */
export const SUPPORTED_PYTHON_VERSIONS = ['3.12'] as const;

/** `process.platform` values covered by the CI matrix. */
export const SUPPORTED_PLATFORMS = ['darwin', 'linux'] as const;

/** `process.arch` values covered by the CI matrix. */
export const SUPPORTED_ARCHITECTURES = ['arm64'] as const;

/**
 * The complete cross-product of the declared Pi and MemPalace versions. Adding a
 * version without adding its pairings here is a compatibility expansion and is
 * rejected by `test/mempalace/compatibility.test.ts`.
 */
export const COMPATIBILITY_PAIRINGS: readonly CompatibilityPairing[] = [
  { pi: '0.84.2', mempalace: '3.6.0', verification: 'verified' },
  { pi: '0.84.2', mempalace: '3.7.1', verification: 'verified' },
];
