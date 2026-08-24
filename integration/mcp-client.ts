// Embedded MCP client — zero runtime deps beyond node:child_process.
//
// Framing: mirrors mempalace/mcp_server.py's `_run_stdio_loop` (lines
// ~5523-5538) exactly — line-delimited JSON-RPC 2.0 over stdio
// (`sys.stdin.readline()` / `json.dumps(response) + "\n"`), NOT
// Content-Length-header framing. One JSON object per line, both directions.
//
// Lazy singleton: the child is spawned on the FIRST tool call, not at
// session start (tools.ts / extension.ts only ever construct this client;
// nothing here spawns eagerly).
import { spawn as defaultSpawn } from "node:child_process";
import { SUPPORTED_MEMPALACE_VERSIONS } from "./compatibility.ts";
import type { Argv } from "./resolve.ts";

export const REQUEST_TIMEOUT_MS = 30_000;
export const SHUTDOWN_GRACE_MS = 3_000;
// A single JSON-RPC line from the server is bounded: past this, stdout that
// never yields a newline is a malfunctioning child, not a large answer, and
// buffering it would grow without limit inside the host process.
export const MAX_STDOUT_BUFFER_BYTES = 8 * 1024 * 1024;
// One of mcp_server.py's SUPPORTED_PROTOCOL_VERSIONS (2025-11-25, 2025-06-18,
// 2025-03-26, 2024-11-05) — the server echoes back whatever it can serve.
const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number | string | null;
	result?: unknown;
	error?: JsonRpcError;
}

type ChildProcess = ReturnType<typeof defaultSpawn>;

export interface McpClientDeps {
	spawn?: typeof defaultSpawn;
	requestTimeoutMs?: number;
	shutdownGraceMs?: number;
	maxStdoutBufferBytes?: number;
	onLog?: (message: string) => void;
	onCompatibilityError?: (message: string) => void;
	/** Group-kill primitive, injectable for tests. Defaults to process.kill
	 * (called with a NEGATIVE pid to signal the whole process group). */
	processKill?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface McpClient {
	callReadTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
	callWriteTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
	shutdown(): Promise<void>;
	isAlive(): boolean;
}

export class IncompatibleCoreError extends Error {
	readonly installedVersion: string;

	constructor(installedVersion: string) {
		const safeVersion = /^[\w.+-]{1,32}$/u.test(installedVersion) ? installedVersion : "unrecognised";
		const supported = SUPPORTED_MEMPALACE_VERSIONS.join(" or ");
		super(`Incompatible MemPalace ${safeVersion}; install MemPalace ${supported}. No memory tool was dispatched.`);
		this.name = "IncompatibleCoreError";
		this.installedVersion = safeVersion;
	}
}

export class UncertainWriteError extends Error {
	readonly toolName: string;

	constructor(toolName: string, cause: string) {
		super(`mempalace-for-pi: '${toolName}' may have completed; outcome is uncertain — ${cause}`);
		this.name = "UncertainWriteError";
		this.toolName = toolName;
	}
}

/** Connection-level failure before a tool request is dispatched. */
class ConnectionError extends Error {}

export function createMcpClient(
	resolveArgv: () => Argv | null,
	cwd: string,
	deps: McpClientDeps = {},
): McpClient {
	const spawnFn = deps.spawn ?? defaultSpawn;
	const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const shutdownGraceMs = deps.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
	const maxStdoutBufferBytes = deps.maxStdoutBufferBytes ?? MAX_STDOUT_BUFFER_BYTES;
	const processKill = deps.processKill ?? process.kill.bind(process);
	const log = (message: string) => {
		try {
			deps.onLog?.(message);
		} catch {
			// logging must never break the client
		}
	};

	let child: ChildProcess | null = null;
	let nextId = 1;
	let initialized = false;
	// The one spawn+handshake in flight. Concurrent cold calls join it instead of
	// racing a second child into existence (the loser of that race is never
	// referenced again and can only be found in the process table).
	let connecting: Promise<NonNullable<ChildProcess>> | null = null;
	// Shutdown is terminal for this client instance. Lifecycle reload creates a
	// new client; this one must never treat intentional teardown as a recoverable
	// connection loss and spawn another child behind the caller's back.
	let closed = false;
	// Bumped by shutdown, so a child that finishes spawning afterwards is
	// released instead of silently outliving the client that asked for it.
	let generation = 0;
	const pending = new Map<
		number,
		{
			resolve: (r: JsonRpcResponse) => void;
			reject: (e: Error) => void;
			timer: NodeJS.Timeout;
			writeToolName?: string;
		}
	>();

	function isChildAlive(): boolean {
		return !!child && child.exitCode === null && child.signalCode === null && !child.killed;
	}

	function failAllPending(err: Error) {
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(
				entry.writeToolName
					? new UncertainWriteError(entry.writeToolName, err.message)
					: err,
			);
		}
		pending.clear();
	}

	function handleLine(line: string) {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg: JsonRpcResponse;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			log(`mempalace-for-pi: unparseable line from MCP child: ${trimmed.slice(0, 200)}`);
			return;
		}
		if (typeof msg.id === "number" && pending.has(msg.id)) {
			const entry = pending.get(msg.id);
			pending.delete(msg.id);
			if (entry) {
				clearTimeout(entry.timer);
				entry.resolve(msg);
			}
		}
	}

	/** Forget `proc` if it is still the current child. A child we already
	 * replaced owns none of this state: its late exit must not fail the
	 * requests its successor is waiting on. */
	function detach(proc: NonNullable<ChildProcess>, reason: string) {
		if (child !== proc) return;
		child = null;
		initialized = false;
		failAllPending(new ConnectionError(reason));
		releaseChild(proc);
	}

	function attach(proc: NonNullable<ChildProcess>) {
		// Framing state is per child and dies with it: a half-written line from a
		// child that died mid-frame must never be prepended to the first response
		// of its replacement, which would corrupt a perfectly good answer.
		let buffer = "";
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				handleLine(line);
				idx = buffer.indexOf("\n");
			}
			if (Buffer.byteLength(buffer, "utf8") <= maxStdoutBufferBytes) return;
			buffer = "";
			const reason = `MCP child stdout exceeded ${maxStdoutBufferBytes} bytes without a line break`;
			log(`mempalace-for-pi: ${reason}; discarding the child`);
			if (child === proc) discardChild(reason);
			else releaseChild(proc);
		});
		proc.stderr?.on("data", () => {}); // diagnostic only — dropped
		proc.on("exit", () => detach(proc, "mempalace MCP child exited"));
		proc.on("error", () => detach(proc, "mempalace MCP child errored"));
	}

	function spawnChild(): Promise<NonNullable<ChildProcess>> {
		const argv = resolveArgv();
		if (!argv) {
			return Promise.reject(new ConnectionError("mempalace-for-pi: no launcher available"));
		}
		const spawnedFor = generation;
		return new Promise((resolve, reject) => {
			let proc: ChildProcess;
			try {
				// detached: own process group, so kills below can reach
				// grandchildren (uv run spawns the actual mempalace-mcp python
				// process; signalling only uv would orphan it — see wakeup.ts).
				proc = spawnFn(argv.cmd, argv.args, {
					cwd,
					stdio: ["pipe", "pipe", "pipe"],
					detached: true,
				});
			} catch (err) {
				reject(
					new ConnectionError(
						`mempalace-for-pi: failed to spawn '${argv.cmd}': ${(err as Error).message}`,
					),
				);
				return;
			}
			let settled = false;
			proc.once("spawn", () => {
				if (settled) return;
				settled = true;
				if (spawnedFor !== generation) {
					// Shutdown happened while this child was still starting.
					releaseChild(proc);
					reject(new ConnectionError("mempalace-for-pi: shutting down"));
					return;
				}
				child = proc;
				attach(proc);
				resolve(proc);
			});
			proc.once("error", (err) => {
				if (settled) return;
				settled = true;
				reject(
					new ConnectionError(`mempalace-for-pi: failed to spawn '${argv.cmd}': ${err.message}`),
				);
			});
		});
	}

	/** One live child, negotiated once. Callers that arrive while a cold start
	 * is in flight await that same start rather than beginning their own. */
	function ensureConnection(): Promise<NonNullable<ChildProcess>> {
		if (closed) return Promise.reject(new ConnectionError("mempalace-for-pi: client is shut down"));
		if (isChildAlive() && initialized) return Promise.resolve(child as NonNullable<ChildProcess>);
		if (connecting) return connecting;
		const attempt = (async () => {
			// Anything still referenced here is dead or half-negotiated; it is
			// never reused, so release it before replacing it.
			if (child) discardChild("replacing an unusable MCP child");
			const proc = await spawnChild();
			await handshake();
			return proc;
		})();
		connecting = attempt;
		const clear = () => {
			if (connecting === attempt) connecting = null;
		};
		attempt.then(clear, clear);
		return attempt;
	}

	/** Signal `proc`'s whole process group (detached spawn above), falling
	 * back to the direct child when the group kill fails or pid is unknown. */
	function killGroup(proc: NonNullable<ChildProcess>, signal: NodeJS.Signals): void {
		try {
			if (typeof proc.pid === "number") {
				processKill(-proc.pid, signal); // negative pid = whole group
				return;
			}
		} catch {
			// group already gone or kill not permitted — fall through
		}
		try {
			proc.kill(signal);
		} catch {
			// already dead
		}
	}

	/** Destroy OUR ends of the child's stdio pipes. Even if a grandchild
	 * survived with the inherited write ends open, no live handle may remain
	 * here — an open pipe stream keeps the host event loop (and thus pi
	 * itself) alive with nothing left tracking it. */
	function destroyStdio(proc: NonNullable<ChildProcess>): void {
		for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
			try {
				stream?.destroy?.();
			} catch {
				// stream already closed
			}
		}
	}

	/** Children we have signalled but not yet seen exit, each with the timer
	 * that will escalate it. Tracked so an escalation always has an owner:
	 * shutdown finishes them instead of leaving a timer — and the process group
	 * behind it — with nobody left to answer for either. */
	const escalating = new Map<NonNullable<ChildProcess>, NodeJS.Timeout>();

	function stopEscalation(proc: NonNullable<ChildProcess>): void {
		const timer = escalating.get(proc);
		if (timer) clearTimeout(timer);
		escalating.delete(proc);
	}

	function forceKill(proc: NonNullable<ChildProcess>): void {
		stopEscalation(proc);
		if (processGroupAlive(proc.pid) || (proc.exitCode === null && proc.signalCode === null)) {
			killGroup(proc, "SIGKILL");
		}
	}

	/** Release a child we are done with: SIGTERM the group now, SIGKILL it once
	 * the grace expires if it ignored the polite signal (uv's Python grandchild
	 * can), and drop our pipe ends immediately either way. */
	function releaseChild(proc: NonNullable<ChildProcess>): void {
		const leaderAlive = proc.exitCode === null && proc.signalCode === null;
		if ((leaderAlive || processGroupAlive(proc.pid)) && !escalating.has(proc)) {
			killGroup(proc, "SIGTERM");
			const timer = setTimeout(() => forceKill(proc), shutdownGraceMs);
			timer.unref?.();
			escalating.set(proc, timer);
		}
		destroyStdio(proc);
	}

	/** Kill the current child (if still alive) and drop our reference to it.
	 * Used whenever we decide a child is no longer usable — a genuinely dead
	 * child costs nothing extra to "kill", but an unresponsive-but-still-alive
	 * one (e.g. after a request timeout) would otherwise leak: its stdio
	 * pipes stay open and keep the event loop (and the OS process) alive
	 * forever with nothing left tracking it. Anything still waiting on that
	 * child fails now rather than waiting out its own timeout. */
	function discardChild(reason: string): void {
		const proc = child;
		child = null;
		initialized = false;
		failAllPending(new ConnectionError(`mempalace-for-pi: ${reason}`));
		if (proc) releaseChild(proc);
	}

	function send(
		method: string,
		params: unknown,
		isNotification = false,
		writeToolName?: string,
	): Promise<JsonRpcResponse> {
		return new Promise((resolve, reject) => {
			const proc = child;
			if (!proc || !isChildAlive()) {
				reject(new ConnectionError("mempalace-for-pi: MCP child not running"));
				return;
			}
			const id = isNotification ? undefined : nextId++;
			const payload: Record<string, unknown> = { jsonrpc: "2.0", method, params };
			if (id !== undefined) payload.id = id;
			const line = `${JSON.stringify(payload)}\n`;

			if (id !== undefined) {
				const timer = setTimeout(() => {
					pending.delete(id);
					if (child === proc) discardChild(`'${method}' timed out`);
					const message = `mempalace-for-pi: '${method}' timed out after ${requestTimeoutMs}ms`;
					reject(writeToolName ? new UncertainWriteError(writeToolName, message) : new Error(message));
				}, requestTimeoutMs);
				pending.set(id, { resolve, reject, timer, writeToolName });
			}

			proc.stdin?.write(line, (err) => {
				if (err) {
					if (id !== undefined) {
						const entry = pending.get(id);
						if (entry) {
							pending.delete(id);
							clearTimeout(entry.timer);
						}
					}
					const message = `mempalace-for-pi: write failed: ${err.message}`;
					reject(
						writeToolName
							? new UncertainWriteError(writeToolName, message)
							: new ConnectionError(message),
					);
				} else if (id === undefined) {
					resolve({ jsonrpc: "2.0" });
				}
			});
		});
	}

	async function handshake(): Promise<void> {
		const initResp = await send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "mempalace-for-pi", version: "1.0.0" },
		});
		if (initResp.error) {
			throw new ConnectionError(`mempalace-for-pi: initialize failed: ${initResp.error.message}`);
		}
		const version = (initResp.result as { serverInfo?: { version?: unknown } } | undefined)
			?.serverInfo?.version;
		if (typeof version !== "string" || !(SUPPORTED_MEMPALACE_VERSIONS as readonly string[]).includes(version)) {
			const error = new IncompatibleCoreError(typeof version === "string" ? version : "version-unknown");
			try {
				deps.onCompatibilityError?.(error.message);
			} catch {
				// Host diagnostics must not affect negotiation.
			}
			discardChild("incompatible MemPalace core rejected");
			throw error;
		}
		await send("notifications/initialized", {}, true);
		initialized = true;
	}

	function extractResult(resp: JsonRpcResponse): unknown {
		const result = resp.result as { content?: Array<{ type: string; text?: string }> } | undefined;
		const content = result?.content ?? [];
		const text = content
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("\n");
		if (!text) return result ?? null;
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	async function attempt(
		name: string,
		args: Record<string, unknown>,
		isWrite: boolean,
	): Promise<unknown> {
		await ensureConnection();
		const resp = await send("tools/call", { name, arguments: args }, false, isWrite ? name : undefined);
		if (resp.error) throw new Error(resp.error.message);
		return extractResult(resp);
	}

	async function callWithRecovery(
		name: string,
		args: Record<string, unknown>,
		isWrite: boolean,
	): Promise<unknown> {
		try {
			return await attempt(name, args, isWrite);
		} catch (err) {
			if (!(err instanceof ConnectionError) || closed) throw err;
			discardChild(`'${name}' lost its MCP child before an answer`);
			try {
				return await attempt(name, args, isWrite);
			} catch (retryError) {
				if (retryError instanceof UncertainWriteError) throw retryError;
				const message = retryError instanceof Error ? retryError.message : String(retryError);
				throw new Error(`mempalace-for-pi: '${name}' failed after respawn — ${message}`);
			}
		}
	}

	function callReadTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
		return callWithRecovery(name, args, false);
	}

	function callWriteTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
		return callWithRecovery(name, args, true);
	}

	function processGroupAlive(pid: number | undefined): boolean {
		if (typeof pid !== "number") return false;
		try {
			process.kill(-pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	function shutdown(): Promise<void> {
		return new Promise((resolve) => {
			closed = true;
			const proc = child;
			child = null;
			initialized = false;
			connecting = null;
			generation += 1;
			failAllPending(new ConnectionError("mempalace-for-pi: shutting down"));
			// Children discarded earlier are still ours until they are gone: finish
			// their escalation now rather than leaving it to a timer that outlives
			// the client.
			for (const stranded of [...escalating.keys()]) forceKill(stranded);
			if (!proc || proc.exitCode !== null || proc.killed) {
				// Already-exited children still need their pipes released: a
				// grandchild holding the inherited write ends would otherwise
				// keep our stream handles (and the host event loop) alive.
				if (proc) destroyStdio(proc);
				resolve();
				return;
			}
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(killTimer);
				destroyStdio(proc);
				resolve();
			};
			const killTimer = setTimeout(() => {
				killGroup(proc, "SIGKILL");
				// SIGKILL on the direct child guarantees an 'exit' (→ finish);
				// this backstop only matters if even that kill was impossible.
				const backstop = setTimeout(finish, 1_000);
				backstop.unref?.();
			}, shutdownGraceMs);
			proc.once("exit", () => {
				if (!processGroupAlive(proc.pid)) finish();
			});
			killGroup(proc, "SIGTERM");
		});
	}

	return { callReadTool, callWriteTool, shutdown, isAlive: isChildAlive };
}
