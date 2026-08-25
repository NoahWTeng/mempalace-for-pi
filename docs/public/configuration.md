# Configuration

There are two places to configure this integration: the environment that launches Pi, for one machine or one launch, and `.pi/mempalace.json`, for settings a project keeps. Values other than the documented literal `1` do not enable boolean environment controls.

## The project document

`.pi/mempalace.json` is the portable half of the configuration. It lives in the project, so a second computer that checks the project out gets the same settings without repeating any export.

```json
{
  "version": 1,
  "palace": "~/palaces/acme-api",
  "readOnly": false,
  "handoff": true,
  "disabled": false,
  "recall": true,
  "rooms": ["invariants", "decisions"]
}
```

| Key | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Required. The only supported contract version. |
| `palace` | non-empty string | Optional. Palace location; `~/` expands to the current user's home directory and a relative path resolves from the project. |
| `readOnly` | boolean | Optional. Refuse every integration write while reads continue. |
| `handoff` | boolean | Optional. Opt in to one bounded pre-compaction diary handoff. |
| `disabled` | boolean | Optional. Start no core process, tools, wake-up, handoff, or background work. |
| `recall` | boolean | Optional. Opt in to per-turn retrieval of project memory relevant to the prompt. |
| `rooms` | list of strings | Optional. Room-name prefixes the session snapshot offers its budget first. At most 16 entries of at most 64 characters. An empty list ranks nothing. |

The document is read strictly and fails closed. Text that is not valid JSON, a document that is not a JSON object, a missing or non-`1` `version`, an unknown key, or a value of the wrong type all refuse the whole document: the integration reports one actionable message, exposes no palace tool, and starts nothing. There is no partial acceptance and no repair.

The document is considered once at the first `session_start` of each Pi launch and is read only if the host says the project is trusted at that point. After granting trust or correcting the document, restart Pi to load it; a reinstall is never needed. An untrusted project document is never read, so the document alone cannot make an untrusted checkout execute anything.

Keep the declared palace portable. Use the `~/` form or a project-relative path; a machine-specific absolute path stops working on the next computer that checks the project out.

## Precedence

Precedence is resolved one field at a time: `MEMPALACE_*` environment variables > `.pi/mempalace.json` > built-in defaults. An environment boolean settles its own field and nothing else, and only the literal `1` enables one — `MEMPALACE_READ_ONLY=0` is a deliberate "not this launch" that overrides a document that asked for read-only. A blank `MEMPALACE_PALACE` declares no location, so the document stays in force.

## Environment controls

| Variable | Behavior |
| --- | --- |
| `MEMPALACE_DIR` | Fallback path to an official MemPalace checkout when `mempalace-mcp` is not on `PATH`; the integration runs `uv run --directory "$MEMPALACE_DIR" mempalace-mcp`. |
| `MEMPALACE_PALACE` | Explicit path to an existing palace. Relative paths resolve from the project; `~/` is supported. This is the only intentional cross-project/reconnection override. |
| `MEMPALACE_BRIDGE_DISABLE=1` | Disable the integration. No core process, tools, wake-up, handoff, or background work starts. |
| `MEMPALACE_READ_ONLY=1` | Refuse integration writes before MCP dispatch; search, status, diary reads, and wake-up reads remain available. |
| `MEMPALACE_HANDOFF=1` | Opt in to one mechanical, bounded pre-compaction diary handoff. Handoff is disabled by default, uses no model call, and is abandoned within 15 seconds. |
| `MEMPALACE_RECALL=1` | Opt in to per-turn retrieval. Each turn searches this project's memory with the prompt and appends as many whole matches as the character budget fits. |
| `MEMPALACE_ROOMS` | Comma-separated room-name prefixes for the snapshot ranking, overriding the document for one launch. Blank entries are dropped; a blank value declares nothing. |

When `mempalace-mcp` is on `PATH`, it takes precedence over `MEMPALACE_DIR`. A typical tested local launch is:

```bash
export MEMPALACE_BACKEND=sqlite_exact
export MEMPALACE_BACKEND_EXPLICIT=sqlite_exact
export MEMPALACE_READ_ONLY=1
pi
```

Unset read-only mode before an intentional write:

```bash
unset MEMPALACE_READ_ONLY
pi
```

## Project identity and worktrees

By default, the integration hashes the canonical Git common directory. Worktrees attached to the same repository therefore share one identity and default palace. Independent clones and forks have different Git directories and remain isolated. Outside Git, the canonical working-directory path is hashed, so unrelated directories remain isolated.

Public status shows the source category for each configuration field: `env`, `project-config`, or `default`. Its configuration block does not show raw absolute paths, resolved values, or palace location details; core status remains separately marked as untrusted data.

To reconnect a retained private-bridge palace without moving it:

```bash
export MEMPALACE_PALACE="$HOME/.mempalace/existing-project-palace"
pi
```

Confirm the target yourself before starting Pi. The integration does not discover, copy, merge, migrate, move, or delete another palace.

## Write controls

`palace_save`, diary writes through `palace_diary`, and automatic handoff all cross the same fail-closed safety gate. Any credential-shaped content in content or metadata rejects the whole write candidate. A `retain:false` tool argument or `[no-memory]` at the start of the first line also rejects the whole candidate. There is no partial redaction, truncation into acceptance, or override.

Read-only mode rejects all three integration write paths while reads continue available. Handoff includes only bounded timestamp, project, branch, message-count, and last-user-text fields. Handoff remains off by default. Enable it either with `"handoff": true` in `.pi/mempalace.json` or with `MEMPALACE_HANDOFF=1`; a present environment value wins for that field, and only the literal `1` enables it.

## The memory explorer

`/palace-explore` adds no configuration key and no environment variable. It reads the palace this project already resolves through the precedence above, starts one host bound to `127.0.0.1` on an ephemeral port inside a trusted session, and authorizes every API request with a per-session token. Read-only mode changes nothing for it, because the explorer only ever reads. See the [memory explorer](memory-explorer.md) for its boundary, its structural-only relationships, and its acceptance evidence.

## Recall

By default a session receives one bounded snapshot of this project's memory before its first turn, and after that the model reaches memory only by calling `palace_search` itself. Recall adds a second layer: with `"recall": true` or `MEMPALACE_RECALL=1`, every turn searches this project's memory using that turn's prompt and appends the matches that fit.

Recall changes what reaches the model, never what is stored. It is scoped to the current project, so a turn cannot surface another project's memory. Retrieved content arrives inside the same inert untrusted-data boundary as the wake-up snapshot, under its own `mempalace-recall` tag.

The cost is paid every turn, so the budgets are deliberately tighter than the session snapshot: at most five matches requested, 2000 rendered characters, and a three-second search. Two guards apply and the character budget usually binds first — with typical drawer sizes about three of the five requested matches fit. Both blocks drop whole records to stay inside their budget rather than cutting the payload mid-record, so what arrives always reads back cleanly and its count is what actually shipped; a single record too large to fit intact is withheld rather than delivered in pieces.

Recall is an enhancement and never a dependency — a blank prompt, an empty palace, a slow core, or a failed search all leave the turn exactly as it would have been without recall, and none of them ends the session. The snapshot is always placed before the recalled block so the stable part of the prompt stays first.

Recall is off by default because it spends a search and part of the cacheable prompt on every turn. Turn it on for a project whose memory you expect the agent to use without being asked.

## What the session snapshot carries

The snapshot is capped at 12000 rendered characters, and a stored drawer serializes to roughly a thousand, so about ten drawers ever reach a session. Which ten is therefore the whole question.

Three rules decide it. Compaction handoffs are left out — they are session bookkeeping, they accumulate faster than anything else, and recall plus `palace_diary` still reach them on demand. The read walks up to three pages of the wing, because the core caps a page at 100 drawers and a working wing outgrows that. What survives is then interleaved by room, one drawer per room per pass, so a single room cannot spend the budget alone.

Room ranking decides who goes first. The shipped default offers the budget to rooms whose names begin `invariants` or `decisions` — the categories that usually mean "this is a lasting fact" rather than "this happened" — up to three drawers each before the rest of the wing is offered anything.

That default encodes one naming convention, so it does nothing for a project that names its rooms differently. Declare `rooms` to replace it:

```json
{ "version": 1, "rooms": ["lessons", "adr", "runbooks"] }
```

Prefixes are matched in the order given, so the first entry is served before the second. `"rooms": []` ranks nothing and leaves plain per-room interleaving. `palace_status` reports which source the ranking came from, so you can tell a declared list from the default.

## Embedding model

Search quality is the core's decision, not this integration's: the model lives in the core's own `~/.mempalace/config.json` (or `MEMPALACE_EMBEDDING_MODEL`), which is per-machine and is not carried by the project document. A second computer therefore starts on the core's default, whatever this project declares.

The core ships two. `minilm` is the historical default and is trained on English only. `embeddinggemma` is multilingual, and the difference is not marginal for a non-English project: on parallel Spanish/English sentence pairs measured against a real palace, mean cosine similarity was 0.895 versus 0.410, and top-1 retrieval for Spanish queries against English drawers went from 1/8 to 8/8.

```json
{ "embedding_model": "embeddinggemma", "embedding_device": "cpu" }
```

Pin `embedding_device` explicitly. Under the default `auto`, ONNX Runtime selected CoreML on an Apple Silicon machine and `embeddinggemma` returned a zero-norm vector for a single input and all-NaN vectors for a batch — silently, with no error raised. A rebuild in that state writes NaN over every drawer while `PRAGMA quick_check` still reports `ok` and the row counts still match. After changing either setting, embed a batch of **two or more** strings and assert the vectors are finite and unit-norm before rebuilding anything: a one-string smoke test returns norm 0 rather than NaN and reads as merely odd.

Switching models changes the vector space, so an existing palace must be re-embedded with `mempalace repair rebuild-index`. That archives the palace first and preserves drawer counts, but it moves the palace directory, which orphans any MCP process already holding it — restart the session afterwards.

See [privacy](privacy.md) for the data boundary and [migration](migration.md) for disable/removal behavior. If the document is refused or the project is untrusted, see [troubleshooting](troubleshooting.md).
