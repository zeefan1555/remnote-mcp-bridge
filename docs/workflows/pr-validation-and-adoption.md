# Pull Request Validation and Adoption Workflow

Use this workflow when evaluating one or more pull requests for `remnote-mcp-bridge`, `remnote-mcp-server`, or a
feature split across both repositories. It is written for human maintainers and coding agents; no particular agent,
editor, or review service is required.

The unit of judgment is the proposed feature, not the pull request. A useful feature may still need substantial
maintainer changes before it is suitable for `main`.

## Outcomes and Authority Gates

Keep the product decision separate from the implementation decision:

- **Intent:** clear, partly clear, or unclear
- **Feature verdict:** accept, reject, or defer
- **Implementation verdict:** accept as-is, adopt with maintainer fixes, reimplement, or not applicable

A request to validate pull requests authorizes read-only inspection, fetching remote state, creating local feature
branches, and running non-live checks. It does not authorize source changes, commits, pushes, GitHub comments, closing
pull requests, or merging.

Use explicit gates:

1. **Assessment gate:** report the judgments and proposed adaptations, then wait for approval such as `go`.
2. **Adoption gate:** after approval, modify and verify the local feature branches. Do not commit or push without an
   explicit request.
3. **Live-validation gate:** run live RemNote integration tests only after an explicit request and confirmation that the
   current bridge build is running.
4. **Merge gate:** commit, push, merge, update pull requests, or delete branches only when explicitly requested.

## 1. Establish Scope and Preserve State

For every pull request, record:

- repository and pull request URL/number
- author and contribution identity for changelog attribution
- base branch, source repository, source branch, and exact head commit SHA
- linked issue, companion pull request, and stated dependency or merge order
- current draft, mergeability, review, and CI/check status

Treat linked bridge and server pull requests as one feature assessment, while retaining per-repository findings and
verification results.

Inspect each worktree before switching branches. Preserve all pre-existing changes, including unrelated untracked or
deleted files. Do not clean, reset, or automatically stash them. Use a separate worktree when practical, or ask the
maintainer how to proceed when existing state prevents a safe checkout.

Fetch current `origin/main` and the exact pull request head. Create a repository-local branch named:

```text
feature/pr-<number>-<short-slug>
```

Fetching the pull request ref is preferable to adding or pushing to the contributor's fork. Confirm that the local
branch head matches the recorded pull request head SHA before reviewing it.

For a GitHub pull request, the usual fetch shape is:

```bash
git fetch origin main
git fetch origin pull/<number>/head:refs/heads/feature/pr-<number>-<short-slug>
git rev-parse feature/pr-<number>-<short-slug>
```

## 2. Collect the Complete Pull Request Record

Read all available context, not only the description and diff:

- pull request description and edits
- linked issues and companion pull requests
- commit list and commit messages
- changed files and full diff
- general conversation comments
- submitted review summaries
- inline review threads, replies, and resolved/outdated state
- author replies and follow-up commits
- CI/check results and relevant failure logs

With GitHub CLI, `gh pr view` is only the starting point. Also inspect the issue comments, submitted reviews, inline
review comments, and GraphQL review-thread state. Inline findings can otherwise be omitted from the review record.

Typical collection commands are:

```bash
gh pr view <number> --repo <owner>/<repo> --json author,baseRefName,body,comments,commits,files,headRefName,headRefOid,headRepositoryOwner,isDraft,mergeable,reviews,state,title
gh api repos/<owner>/<repo>/issues/<number>/comments --paginate
gh api repos/<owner>/<repo>/pulls/<number>/reviews --paginate
gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate
gh pr checks <number> --repo <owner>/<repo>
```

Use GitHub's GraphQL `reviewThreads` connection when resolution or outdated-thread state matters; the REST inline
comments response alone does not expose the complete thread state.

Treat human and automated review comments as hypotheses. Reproduce or disprove each material claim against the current
code, contracts, and tests. Record every material comment as one of:

- valid and needs a fix
- valid and already addressed
- invalid, with a concise technical reason
- useful improvement but outside the accepted scope
- deferred, with the follow-up location or rationale

Do not equate a passing check, an AI-generated severity label, or an author's test claim with independent validation.

## 3. Evaluate Intent and Product Fit

State the author's intent in plain language before judging the implementation. If the intent cannot be stated
unambiguously, identify the missing product or contract decision.

Evaluate whether the feature belongs in the projects:

- Does it solve a real MCP, CLI, bridge, or RemNote workflow problem?
- Is the behavior consistent with the existing product and contract direction?
- Is the scope appropriately small, or does it introduce unrelated behavior?
- Is the benefit worth its API, compatibility, security, and maintenance cost?
- Can the behavior be explained, tested, and supported reliably?
- Is there a simpler solution using an existing action, tool, or workflow?
- Does it preserve user-data safety and predictable agent behavior?

Reject or defer the feature when the product direction is wrong, the maintenance burden is unjustified, or essential
behavior remains undefined. Do not keep a feature merely because the submitted code is technically competent.

## 4. Review the Implementation

Review the local pull request branches against fresh `origin/main`. Prioritize correctness and behavioral risks over
style. Check at least:

- request, response, and error contracts
- input validation and runtime boundary validation
- pagination, timeouts, retries, and stale-state behavior where applicable
- compatibility between bridge, server, MCPB, and bundled CLI
- failure behavior for unavailable or mismatched companion versions
- user-data safety for writes and security boundaries for paths, files, URLs, or external input
- concurrency, resource cleanup, and lifecycle behavior
- generated artifacts and package/manifest consistency
- test quality, documentation accuracy, and changelog completeness

For a cross-repo feature, build a small contract matrix covering action/tool names, request fields, response fields,
errors, capabilities, and version behavior. Confirm both repositories implement the same contract.

Assess mixed deployments explicitly:

- old bridge with new server
- new bridge with old server
- temporary state while only one repository has been merged or released

Require capability negotiation, compatibility handling, or a safe merge order when a mixed deployment would otherwise
fail or expose incomplete behavior.

## 5. Establish an Unmodified Baseline

Before maintainer edits, run the affected repositories' canonical non-live quality checks when practical. This
distinguishes failures already present in the pull request from regressions introduced during adoption.

At minimum:

- inspect existing CI/check results
- run focused tests for high-risk behavior or disputed review comments
- run `./code-quality.sh` in each affected repository when the branch is expected to be buildable
- record failures, skipped checks, and environment limitations

Paired branches may need to be present together for meaningful contract checks, but live RemNote tests remain behind
the explicit live-validation gate.

## 6. Produce the Assessment Report

Report findings first, ordered by severity and tied to files or contracts. Keep feature-level and repository-specific
findings distinct.

Use this compact decision record:

```text
Intent: clear | partly clear | unclear
Feature verdict: accept | reject | defer
Implementation verdict: accept as-is | adopt with maintainer fixes | reimplement | not applicable

Blocking findings:
Non-blocking improvements:
Reviewer-comment dispositions:
Missing tests/docs/contracts:
Maintainer adaptation plan:
Verification plan:
Residual questions or risks:
```

For an accepted feature, describe the changes the maintainers should make themselves. Stop at this gate and wait for
approval before editing source files.

## 7. Adopt on Local Feature Branches

After approval, re-fetch the pull request metadata, comments, and head SHA. If the contributor updated the pull request,
review the delta before editing.

Fetch fresh `origin/main`, then rebase or merge it into every local feature branch before adaptation. Resolve conflicts
in the context of the accepted feature; do not silently discard contributor work. Reconfirm paired branches still
implement one coherent contract.

Keep maintainer adaptations scoped to merge readiness:

- fix correctness, validation, security, compatibility, and lifecycle defects
- complete bridge/server contract parity
- maintain bundled CLI parity, or document the explicit reason it does not apply
- regenerate MCPB metadata through the canonical generator when tool definitions change
- add focused unit and contract tests, including negative and boundary cases
- update live integration workflows for every reachable consumer path
- update public contract, tool, CLI, configuration, and compatibility documentation
- evaluate and update `remnote_get_playbook`
- evaluate and update `skills/remnote/SKILL.md`
- evaluate and update `docs/agent-validation-prompts/mcp-tool-smoke-test.md`
- update both changelogs for cross-repo behavior

Do not automatically bump package versions during pull request adoption. When release/version work is explicitly in
scope, update every package, lockfile, manifest, and compatibility signal required by the repository release policy.
Keep changelog release headings unchanged unless release preparation is also requested.

When the feature will be merged, add contributor attribution to each affected changelog. Use the established changelog
style and the contributor's recognizable GitHub identity. Attribution remains required when maintainers substantially
modify or reimplement the contribution.

Preserve original author commits where practical. Push only the maintainer-owned local feature branches; never push to
the contributor's fork branch without explicit authorization.

## 8. Verify Merge Readiness

Run final non-live verification in every changed repository:

- focused unit and contract tests
- `./code-quality.sh`
- generated-file freshness checks
- production build checks where required by the changed surface
- `git diff --check`
- worktree and branch status inspection

Review integration-test adequacy before running the live suite. Coverage should test behavior rather than only
transport success and should include, where applicable:

- primary successful workflow
- invalid, missing, stale, oversized, or incompatible input
- capability/version mismatch behavior
- paging or continuation behavior
- persisted readback after writes
- direct MCP path
- MCPB/stdio proxy path
- bundled CLI path
- repeatable setup, unique test data, and documented cleanup

If a consumer path cannot expose the feature, record why its integration coverage does not apply.

Live validation must follow the current policies in both repositories and the canonical integration-testing guide in
`remnote-mcp-server`. In particular:

1. Ask the maintainer to start or restart the bridge after the latest bridge code change.
2. Run `run-agent-integration-test.sh --preflight-only` as required by the local execution environment.
3. Refuse to continue when the configured MCP HTTP port is already occupied; do not stop unrelated services.
4. Run live suites only through `run-agent-integration-test.sh`.
5. Prefer the full MCP, MCPB, and CLI suite for final cross-repo validation.
6. Report suite, workflow, step, and skip counts plus any persistent RemNote test artifacts.

When live validation fails, localize the failure before changing contracts or merge decisions:

- Record which suites did not run because an earlier suite failed; treat them as unverified, not passed.
- Collect both sides of the boundary: MCP/server runner logs and bridge/RemNote console logs.
- Correlate the failing action or request with the last completed checkpoint or observable response boundary.
- If the app or bridge appears stuck, allow one clean rerun after restart and record why; repeated failures require
  debugging, not another blind rerun.
- When logs are insufficient, add narrowly scoped diagnostics to isolate the async boundary, then decide before merge
  whether the diagnostics are permanent operational signal or temporary debug scaffolding.

## 9. Refresh Before Commit and Merge

Immediately before committing or merging, refresh:

- `origin/main`
- pull request head SHAs and commits
- general and inline comments
- review-thread resolution state
- CI/check status

If a pull request changed, inspect the delta and reconcile it with maintainer changes. If `main` advanced, rebase or
merge again and rerun checks proportional to the affected surface. Original pull request CI does not validate rebased
or maintainer-modified branches.

When explicitly requested:

1. Commit and push each local `feature/pr-<number>-<short-slug>` branch.
2. Verify the remote feature branch points to the expected commit.
3. Confirm both sides of a paired feature are ready before either reaches `main`.
4. Choose and report a safe merge order based on mixed-version compatibility.
5. Update local `main` from `origin/main` with a fast-forward-only pull.
6. Merge the verified local feature branches, preferring fast-forward-only history when available.
7. Push `main` and verify local `HEAD` equals `origin/main` in every affected repository.

Do not claim completion while a required test, push, or merge process is still running.

## 10. Close the Contribution Loop

After merge, verify whether GitHub recognized the original pull requests as merged. Rebasing or reimplementation may
leave fork pull requests open even though the feature is now on `main`.

When explicitly authorized:

- comment with the adopted commit or release references
- thank and credit the contributor
- explain material maintainer changes without reopening settled review debate
- close pull requests that did not close automatically
- delete local or maintainer-owned remote feature branches when no longer needed

The final report should include:

- feature and implementation verdicts
- merged commit SHA per repository
- contributor attribution status
- tests and quality checks run, with results
- live integration results or an explicit reason they were not run
- merge order and compatibility assumptions
- remaining risks, follow-ups, and pull request closure state
- workflow retrospective and any proposed reusable process improvements

## Merge-Ready Definition

A contribution is merge-ready only when:

- the feature is intentionally accepted
- all blocking findings and valid review comments are resolved or explicitly deferred
- bridge, server, MCPB, and CLI behavior are aligned where applicable
- unit, contract, documentation, playbook, skill, smoke-test, and integration impacts were evaluated
- mandatory changelog entries include contributor attribution
- local branches include current `origin/main`
- required non-live checks pass
- required live integration tests pass
- mixed-version behavior and merge order are understood
- final pull request heads and comments were refreshed
- no unrelated worktree changes were modified

## 11. Retrospect and Improve the Workflow

After every terminal outcome, including merge, rejection, or deferral, review the actual validation session for ways to
make future pull request processing safer, clearer, or more efficient.

Consider:

- steps that caused avoidable delay or rework
- missing information, checks, tools, or authority gates
- defects or review findings that the workflow should have prompted earlier
- redundant, unclear, or incorrectly ordered steps
- commands, paths, or repository policies that have become stale
- opportunities to simplify the workflow without weakening validation

Only add lessons that are independent of the reviewed pull request's content and reusable for future pull requests in
either repository. Do not add feature names, pull request numbers or URLs, API-specific findings, implementation
details, or one-off workarounds to this workflow.

Classify each lesson before proposing a change:

- **Reusable process lesson:** propose an update to this canonical workflow.
- **Repository-specific lesson:** propose an update to the affected repository's instructions or documentation.
- **Pull-request-specific lesson:** keep it in the pull request report or a follow-up issue.
- **Transient event:** do not preserve it unless it exposes a recurring process risk.

A workflow update should address either a generally reusable improvement demonstrated by the session or a serious
process gap that could permit an incorrect merge, lost attribution, unsafe operation, or incomplete verification. The
workflow may be simplified or have obsolete steps removed; improvement does not mean accumulating more checklist
items.

Report the retrospective in this form:

```text
Workflow retrospective:
Observed friction:
Reusable lesson:
Proposed workflow change:
Expected benefit:
Decision: no change needed | approval requested
```

Do not modify this workflow automatically. Present the evidence and proposed process-level change, then wait for
explicit approval. A workflow-only follow-up does not recursively trigger another retrospective.
