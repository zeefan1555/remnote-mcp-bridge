# AGENTS.md

This file is a map for AI agents working in `remnote-mcp-bridge` (RemNote Automation Bridge plugin).

## Repo Role

This repo is the bridge plugin between RemNote SDK and two external consumer paths:

```text
MCP path: AI assistant <-> remnote-mcp-server <-> this plugin <-> RemNote SDK
CLI path: automation/agents <-> remnote-cli <-> remnote-mcp-server <-> this plugin <-> RemNote SDK
```

The plugin is a WebSocket client (default server URL: `ws://127.0.0.1:3002`).

## Companion Repos (Sibling Dirs)

Resolve from this repo root (`$(pwd)`):

- `$(pwd)/../remnote-mcp-server` - MCP transport/tool surface and bundled `remnote-cli`

When changing contracts, check this repo and `remnote-mcp-server`. The old standalone `remnote-cli` repo is
discontinued; maintained CLI code lives in `remnote-mcp-server/src/remnote-cli/`.

## Contract Map (Current)

### External Bridge Action Surface

- `create_note` (simple note creation, optional root document status, hierarchical markdown import, markdown flashcards)
- `search`
- `search_by_tag`
- `read_note`
- `get_review_stats` (native card repetition and scheduling facts for exact Rem IDs)
- `get_sdk_capabilities` (generated inventory of the SDK 0.0.46 callable public surface)
- `sdk_call` (expert-only invocation by registered capability ID with write/destructive gates)
- `get_media_locator` (capability-gated RemNote-managed image token resolution)
- `list_children`
- `move_note`
- `update_note`
- `set_document_status`
- `insert_children`
- `replace_children`
- `update_tags`
- `set_property`
- `append_journal`
- `read_table`
- `get_status`

### Compatibility and Version Signaling

- On connect, plugin sends WebSocket `hello` with plugin version.
- Projects are in `0.x`; prefer matching minor lines across bridge and the server package.
- Compatibility guide: `docs/guides/bridge-consumer-version-compatibility.md`.

Before changing `search`/`read` output semantics, read:

- `docs/reference/remnote/README.md`
- `docs/reference/remnote/bridge-search-read-contract.md`

## Code Map

- `src/widgets/index.tsx` - plugin activation + widget registration
- `src/widgets/mcp_bridge.tsx` - bridge action dispatcher + UI panel state
- `src/bridge/websocket-client.ts` - WS lifecycle, reconnect backoff, `hello`
- `src/api/rem-adapter.ts` - action execution against RemNote SDK
- `src/settings.ts` - plugin settings keys/defaults
- `public/manifest.json` - plugin metadata/version

## Development and Verification

For maintainer review of one or more bridge/server pull requests, follow
`docs/workflows/pr-validation-and-adoption.md` before modifying or merging the contribution.

If Node/npm is unavailable in shell, run:

```bash
source ./node-check.sh
```

Core commands:

```bash
npm run dev
npm run build
npm run typecheck
npm run check:sdk-capabilities
npm test
npm run test:coverage
./code-quality.sh
./run-prod-build.sh
```

The SDK expert registry is generated from the installed `@remnote/plugin-sdk` declaration files. After changing that
dependency, run `npm run generate:sdk-capabilities`; the drift check must pass before commit. Do not add dynamic method
lookup outside the generated allowlist or expose callback/stateful object handles over JSON.

Use `./run-prod-build.sh` for production-style local verification (no hot reload).

## Integration and Live Validation Policy

- This repo does not ship a dedicated `npm run test:integration` flow.
- When live RemNote verification is required, use a real RemNote session. If the user explicitly grants full-operation
  authority, the agent may load or reload the localhost plugin through Computer Use; otherwise ask the human
  collaborator to do it.
- If bridge code changed after the current RemNote bridge session started, reload the localhost plugin before live
  integration. Under full-operation authority the agent performs and verifies that reload.
- CLI and MCP server live integration tests use the same `remnote-mcp-server` bridge connection.
- AI agents must run server-side live integration through `../remnote-mcp-server/run-agent-integration-test.sh`, not
  `run-integration-test.sh` or `npm run test:integration*`. Before invoking it, run
  `../remnote-mcp-server/run-agent-integration-test.sh --preflight-only` outside the Codex sandbox; if anything is
  listening on the configured HTTP MCP port, identify its owner before continuing. Under full-operation authority, the
  agent may stop and later restore only the confirmed project-owned `com.remnote.mcp-server` launchd service. For any
  unknown listener, refuse to stop it and ask the human collaborator.
- Agent-assisted live integration must run outside the Codex sandbox with escalated execution because the `tsx` runners
  create macOS temp-directory IPC pipes that can fail under sandboxing with `listen EPERM`.
- Use local unit/static/build checks for agent-side verification.

## Documentation and Changelog Rules

- Update documentation when behavior, contracts, configuration, or non-obvious rationale changes.
- Record notable functional and documentation changes in `CHANGELOG.md`.
- Keep AGENTS/docs map-level: rationale, constraints, contracts, and navigation.
  - Avoid restating implementation details obvious from code.
- When changing bridge action contracts or response semantics that are visible through MCP/CLI consumers:
  - Treat the change as a cross-repo public surface change. Work normally starts in this bridge repo, so decide the
    server/CLI/agent-facing parity plan before implementing the bridge behavior.
  - Check sibling `../remnote-mcp-server` schemas, tool definitions, integration tests, `remnote_get_playbook`, and
    `docs/agent-validation-prompts/mcp-tool-smoke-test.md`.
  - Check whether bundled `remnote-cli` parity is expected. If yes, update the command parser, bridge-action-to-tool
    mapping, text/JSON output expectations, CLI command reference, and CLI integration coverage in
    `../remnote-mcp-server`.
  - Check whether `../remnote-mcp-server/skills/remnote/SKILL.md` needs updates for command names, flags, write
    safety, traversal defaults, or recovery guidance.
  - Do not leave a behavior MCP-only when an equivalent CLI workflow is expected. If CLI parity is intentionally
    rejected, record the rationale in docs/changelog and call it out to Robert before finishing.
  - Update bridge/server contract docs and changelogs together when behavior spans both repos.

## Release and Publishing Map

For bridge releases, update:

1. `package.json` version
2. `public/manifest.json` version object
3. `CHANGELOG.md` (`[Unreleased]` -> dated release section)

Publishing helper:

- `./publish-to-marketplace.sh`

## Git Policy

This user-maintained fork follows a single-maintainer workflow. For requested changes, run proportional verification,
commit directly on `main`, and push to `origin/main`. Do not open or update a pull request unless the user explicitly
asks for one. Keep the pull-request documentation for evaluating external contributions.
