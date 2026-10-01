# Task command contract (schema 1)

The 0.24.0 task commands use bounded live read windows, not atomic snapshots or
transactions. No rollback or cross-device exactly-once guarantee is offered.
The maintained CLI/server schemas and leaf `--help` give complete JSON examples.

## Reads

- `remnote-cli context --request -` → `remnote_inspect_many` / `inspect_many`
- `remnote-cli verify scope --expect -` → `remnote_verify_scope` / `verify_scope`

A context request has `schemaVersion:1` and at least one selector: `remIds` (100),
`subtreeRootIds` (10), `tagRemIds` (10). `maxRems` is 1–1000 (default 1000,
including ancestors); `ancestorDepth` is 0–20 (default 20). Entity descendants are
followed, not references/portals. The initial exact IDs use SDK `findMany`.

Only explicit `remIds` include title/raw text/back text/aliases and
`contentIncluded:true`. Broad subtree and tag results omit prose. All objects
contain identity, parent/ordered children/ancestors, type/structural card flags,
strict tag IDs, references, cc/u flags, native card IDs/history and raw-text hash.
Empty raw SDK text serializes as null, with SHA256(JSON(null)). Metadata/content
objects have a 1 MB output budget. Failed/missing/truncated reads are incomplete;
SDK tag failures never become empty tags or prove absence. Inverse tag membership
is independent, from explicitly requested `tagRemIds`.

Verification wraps `inspect` and 1–200 expectations: parent, remType, ancestor,
tag, powerup, children, references, cardRemIds, zeroCards. Children compare order;
references/card IDs compare sets. `exact:false` permits subset references or an
ordered child subsequence. Tag `present`/`inverse` default true. `zeroCards` also
rejects disabled/residual native card structure by default. Subtree checks require
an explicitly requested complete root scope. Missing evidence/errors/truncation
never pass. Do not narrow required WIKI/full-card scope to evade a limit.

No read command uses date namespace, local journal or any note write. There is no
cross-request content cache. Receipts describe their actual read window.

## Writes

- `remnote-cli flashcards apply --plan - --idempotency-key KEY [--apply]`
- `remnote-cli wiki apply --plan - --idempotency-key KEY [--apply]`

No `--apply` means preview. The bridge envelope is schemaVersion, plan, dryRun
(default true) and idempotencyKey. Plans are strict schema 1, bounded to 100 KiB
and at most 1000 combined receipt IDs. Preview does not access the journal or
create/read a date document. The CLI submits a single server/bridge task operation;
SDK awaits still occur inside it. The bridge checks the current write gate and
45-second phase deadline at each new mutation; in-flight calls cannot be cancelled.
The matching server timeout is 60 seconds; transport timeout is an uncertain outcome.

Flashcards use explicit existing `dailyRemId`, `homeRootId`, `tagRemId`, up to seven
newCards and/or exact existing answer patches/reused cards. Two or more new cards
require a title and receive cc on an ordinary topic root. The daily target must be
native dailyDocument; ID/type alone does not prove calendar freshness. The caller
resolves and verifies the intended day and re-resolves a new batch after midnight.
Replay retains the original target. Composite preview/apply makes no date call.
Fixed scaffold Markdown is used only to establish native cards; actual questions
and answers are typed rich text. Semantic deduplication/quality remains the agent's
responsibility. Existing answer patches preserve exact card IDs/native history,
front text, parent, children and tags; no replacement/deletion/history reset.

Wiki uses exact root/partition/index/log IDs, explicit page/node plans and typed
literal strings or native `{remId}`/local `{pageKey}` references. It never parses
Markdown. Existing title must match; Wiki nodes must remain ordinary untagged
non-card text, including no disabled inline card delimiter. Literal arrows are
ordinary strings. The deterministic canonical/alias guard covers the selected
partition and plan; the agent still performs semantic/whole-WIKI deduplication.
The complete index entity tree is searched. Only the leading non-whitespace native
page reference establishes index ownership, not later summary references. Duplicate
or ambiguous ownership conflicts. Existing nested entries retain their location.
Grouped indexes require a unique existing entry: the plan has no insertion-section
field, so missing entries fail before writes. Use the established exact-section
workflow first; never flatten or narrow the ownership scan.
Only actual page/index changes produce one log; reference-only and reused/no-op
work does not. The batch date is stored once for replay. Full WIKI is scanned after
writes for zero active cards and no residual card structure.

## Recovery and receipts

Receipts have schemaVersion, kind, batchKey, planHash, status, complete,
ids, facts, created/updated/reused/skipped, steps, checks, errors and readWindow.
Semantic IDs include root/daily/tag, card:KEY, answer:KEY:INDEX, page:KEY, node:KEY,
index:KEY and log:batch. Facts contain only IDs, text hashes and native-card/review
hashes. Keep note content and stdin plans ephemeral, not persistent workflow proof.

The local SDK journal is scoped by KB/kind/batch key and stores metadata only.
Changed plans under a key conflict. A create is marked started before its SDK
call; an unrecorded/uncertain result is unknown and never blindly retried. Do not
switch batch keys to evade this guard. Wiki known IDs can resume after complete
fresh type/tags/card-structure/parent/text preconditions, all before the first setter
including reparenting. The shared native card predicate is also used by inspection.

The complete scaffold logical-key mapping and original ordered entity structure
are saved durably with successful creation, before any question/answer setter.
Recovery uses those identities, never current sibling order. Missing bindings or
external reorder/reparent conflicts before mutation. A failed checkpoint stays
started/unknown. Completed text steps and completed tasks never restore external
edits to old text; completed replay also never restores removed aliases, cc or
outline state. Metadata journal I/O on replay is allowed; no-op does not mean no I/O.

SDK capability caching contains metadata only, bound to the accepted live endpoint,
CLI/server/bridge/SDK versions and generated official catalog hash. Local payload
integrity and live identity are revalidated; no offline or stale fallback. SDK calls
carry expectedCatalogHash which the bridge rechecks before invocation.
