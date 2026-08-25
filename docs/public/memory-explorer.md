# Memory explorer

`/palace-explore` opens a read-only browser view of the current project's memory. It is a
local surface for reading what the palace already holds: search a remembered decision,
select it, read its recorded content and evidence, and inspect the bounded neighborhood
around it.

## Opening the explorer

Run `/palace-explore` inside a trusted session. The command starts one HTTP host bound to
`127.0.0.1` on an ephemeral port and opens your default browser at that address. Nothing is
served before the session is authorized, and no port is opened until you run the command.

Every API request carries a 256-bit bearer token that exists only for that session. The
token travels in the URL fragment, so it never reaches the server as a path or query, and it
is never written to a log or to persisted state. A request with a wrong token, a wrong
`Host`, a foreign `Origin`, or any method other than `GET` receives no memory data.

The host is local only. There is no remote hosting path, no proxy, no shared link, and no
collaboration surface. Closing the session closes the host; the browser tab then reaches
nothing.

## What the explorer can and cannot do

The explorer never writes. It reads through the same official MemPalace read tools the
integration already uses — `mempalace_list_drawers`, `mempalace_get_drawer`, and
`mempalace_search` — and it has no write path at all, so browsing cannot create, edit,
delete, or reorder a memory.

What reaches the browser is filtered before it leaves the process:

- Absolute paths are redacted. A file URI, a UNC path, or any absolute filesystem path in
  content, metadata, or a source label is replaced with a redaction marker; only a
  project-relative label or a bare file name survives.
- Credential-shaped content is redacted with the same catalogue the write gate uses.
- Only the current project's wing is readable. Another project's memories are dropped
  before any view is built.
- Record identifiers are per-session handles, not reversible palace identifiers.

## Relationships are structural

Every relationship the explorer displays today is **structural**: two memories share a room,
or they were filed from the same source. Structural relationships are labeled as such and
never presented as meaning.

Knowledge graph relationships are unavailable in this configuration because the public
knowledge graph read cannot be scoped to the active project wing. The explorer does not make
that unscoped read and says `unavailable` rather than crossing the project boundary or filling
the gap. Confidence, validity windows, and temporal status render as `unavailable` rather
than as a guess. The
explorer never synthesizes similarity edges or infers a relationship that the core did not
record.

The view is bounded on purpose: at most 100 memories are visible, each expansion adds at
most 25, and every view reports how many relationships are available, displayed, and
omitted.

## Configuration

The explorer adds no configuration key and no environment variable. It uses the palace this
project already resolves — see [configuration](configuration.md) — and it honors read-only
mode trivially, because it only ever reads.

## Acceptance evidence

Two validators back the explorer's published thresholds, both reached through
`npm run test:explorer`. Both refuse to invent evidence: a
missing browser, a missing core, or missing human evidence is reported as `needs-attention`
and never as a pass.

### Browser performance

```sh
npm run test:explorer -- --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

This requires a real Google Chrome binary; the harness drives it over the DevTools protocol
and adds no dependency. It builds a 10,000-memory corpus, records 20 cold starts and 20 warm
searches through the real user interface, and fails when the nearest-rank p95 cold start
exceeds 2 seconds or the nearest-rank p95 warm search exceeds 500 milliseconds. Without an
executable browser the run stops with `needs-attention`.

### Reference study

```sh
npm run test:explorer -- --study test/mempalace/fixtures/explorer-study.json
```

The study validator accepts evidence of exactly 30 attempts — 10 developers, 3 attempts each
— and rejects any file with fewer than 27 complete journeys under 30 seconds, with fewer or
more than 30 attempts, or with thresholds edited below the published ones.

The committed fixture is deterministic **synthetic reference data**. It exists to prove the
validator, it declares itself as synthetic, and the validator prints `needs-attention` for it
rather than a success claim: recording a real 10-developer study is runtime-verification work
and no success criterion is claimed from that file.

### Packaged journey

`npm run test:packaged` installs the packed candidate and then opens `/palace-explore` from
the installed package, completing search → select → details → neighborhood against both
supported MemPalace versions.

## Related

- [Privacy boundary](privacy.md) — storage, networking, and non-retention.
- [Configuration](configuration.md) — palace resolution, environment controls, and write policy.
- [Troubleshooting](troubleshooting.md) — missing core, permissions, and cleanup.
