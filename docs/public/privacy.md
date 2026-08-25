# Privacy boundary

MemPalace for Pi is local-first. The integration starts the separately installed official `mempalace-mcp` process over local stdio and passes a local palace path. It has no telemetry, cloud sync, account service, or package-owned remote API.

After required software and local assets have been provisioned, routine wake-up, search, save, diary, status, handoff, reload, and shutdown operations make no routine non-loopback network requests on the tested local backend. Pi's model provider is outside the integration's control; recalled memory enters normal Pi context and the provider may use the network according to Pi's configuration. An explicitly selected remote MemPalace backend is also outside the local-only claim.

## Storage and recall

The official core owns every durable palace file, schema, backup, and migration. The integration neither vendors the core nor keeps a second memory database. Default project selection uses a non-secret identity digest. Public tool/status output does not reveal the raw palace path.

At session start, one wake-up snapshot is captured with a 10-second budget, at most 1 MiB of source output, and at most 12000 rendered Unicode characters. The read walks at most three pages of the project's wing so a wing larger than one core page is still represented. Compaction handoffs are left out of the snapshot — recall and `palace_diary` still reach them — and the remaining drawers are interleaved by room, with rooms named `invariants…` or `decisions…` offered the budget first, so one room cannot spend it alone. The exact rendered snapshot is reused for that session. Stored text is serialized as inert, untrusted data; it is not promoted to system or developer instruction.

## Non-retention and credentials

Every integration-originated write uses one fail-closed gate:

- `retain:false` rejects the whole candidate.
- A first-line `[no-memory]` marker rejects the whole candidate.
- Credential-shaped content in either content or metadata rejects the whole candidate.
- Read-only mode rejects writes before MCP dispatch.

There is no partial redaction and no override. Rejection means this integration does not dispatch that candidate to durable storage; it does not claim to erase copies already present in Pi sessions, provider systems, shell history, logs, or an existing palace.

Handoff is opt-in, off by default, mechanical, field-allowlisted, bounded, and makes no model call. Enable it with `"handoff": true` in `.pi/mempalace.json` or with `MEMPALACE_HANDOFF=1`; a present environment value takes precedence for that field, and only the literal `1` enables it. Disable the integration entirely with `MEMPALACE_BRIDGE_DISABLE=1` when no process or memory access is wanted.

Repository and package inspection reject credentials, user palace data, machine-specific configuration, private paths, hidden state, retired runtime source, benchmarks, and internal planning documents. The tracked public boundary contains only the current MemPalace integration. See [configuration](configuration.md) and [migration](migration.md).
