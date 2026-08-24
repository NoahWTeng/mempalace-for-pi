#!/usr/bin/env node
// An executable stand-in for the official `mempalace-mcp` console script.
//
// `resolveLauncher` looks for `mempalace-mcp` on PATH, so proving that lookup
// needs a real executable file on a real PATH entry. Tests copy this file into a
// temporary directory under the name `mempalace-mcp` with the executable bit
// set; running it hands the connection to the deterministic server fixture, so a
// PATH-resolved launcher can be driven end to end.
//
// It accepts and ignores the `--palace <dir>` argument the integration passes,
// because a fixture owns no storage.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), 'fake-mempalace-server.mjs');
process.argv = [process.argv[0], server, process.env.FAKE_MEMPALACE_MODE ?? 'normal'];
await import(server);
