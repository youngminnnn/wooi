# Interoperating with GitHub Stacked Pull Requests

**English** · [한국어](./gh-stack-interop.ko.md)

GitHub shipped stacked pull requests to public preview on 2026-07-30. This document records
what the feature actually is, how it overlaps with Wooi's existing stacking, and what Wooi
should do about it.

**Recommendation: adopt partially.** Publish Wooi's stacks to GitHub so they render as
first-class stacks on github.com, and read stack membership back from the GitHub API. Do
**not** adopt the `gh stack` extension's local branch tracking, and do **not** hand cascade
control to `gh stack sync`. `cascade.ts` stays the engine. The reasoning is in
[Recommendation](#recommendation).

Claims below are marked **[verified]** when this document's author reproduced them against
`gh stack` v0.1.0 / the live GitHub API on 2026-08-11, and **[unverified]** when they come
from documentation alone or could not be exercised without creating real pull requests.

## 1. Findings

### 1.1 The extension surface

`gh stack` v0.1.0 installs from `gh extension install github/gh-stack`. The repository
(`github/gh-stack`) is public and MIT-licensed, so behavior below was checked against source
as well as against the binary. **[verified]**

Release cadence is roughly fortnightly: v0.0.1 on 2026-04-10 through v0.1.0 on 2026-07-29,
nine releases in four months. **[verified]** The extension is young and moving.

Commands, grouped as the CLI groups them: **[verified]**

| Group | Commands |
|---|---|
| Stack management | `add`, `checkout`, `init`, `modify`, `unstack`, `view` |
| Remote operations | `link`, `merge`, `push`, `rebase`, `submit`, `sync` |
| Navigation | `bottom`, `down`, `switch`, `top`, `trunk`, `up` |
| Utilities | `alias`, `feedback` |

Only two of these matter to Wooi: `link` and `merge`. The rest either duplicate what Wooi
already does or actively conflict with it.

The extension documents a stable exit-code table in its bundled agent skill: **[verified,
from the skill; codes 0/2 reproduced]**

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic error |
| 2 | Not in a stack |
| 3 | Rebase conflict |
| 4 | GitHub API failure |
| 5 | Invalid arguments |
| 6 | Disambiguation required |
| 7 | Rebase already in progress |
| 8 | Stack file locked |
| 9 | Stacked PRs unavailable on the repository |
| 10 | Modify recovery required |

Exit 9 is the feature-gate signal. The binary carries the matching string
`Stacked PRs are not enabled for this repository`. **[verified]**

Machine-readable output exists but is thin. `gh stack view --json` on v0.1.0 emits exactly:
**[verified]**

```json
{
  "trunk": "main",
  "currentBranch": "L3",
  "branches": [
    { "name": "L1", "base": "<sha>", "isCurrent": false,
      "isMerged": false, "isQueued": false, "needsRebase": false }
  ]
}
```

Note what is missing: **no PR number, no PR URL, no stack number, and no `head` sha** — even
though the bundled skill documents `branches[].head` and a `branches[].pr` object with
`number`, `url`, and `state`. The shipped v0.1.0 binary does not emit them. **[verified]**
This is a documentation/implementation mismatch in the preview, and it means `view --json`
alone cannot tell Wooi which PR a branch belongs to. Wooi would have to correlate by branch
name — which is exactly what it already does without the extension.

`base` is a **saved SHA of the parent branch**, not a branch name, and it may be stale;
`needsRebase` is the derived "parent tip is no longer an ancestor" flag. **[verified]**

### 1.2 Local tracking state is per-worktree, and that is disqualifying

This is the single most important finding for Wooi.

`gh stack` stores its stack tracking in a JSON file at `<git-dir>/gh-stack`, guarded by
`<git-dir>/gh-stack.lock`. The path is `filepath.Join(gitDir, "gh-stack")` where `gitDir` is
`git rev-parse --git-dir`. **[verified, empirically and in `internal/stack/stack.go`]**

`git rev-parse --git-dir` is **per-worktree**. In a linked worktree it resolves to
`.git/worktrees/<name>/`, not to the shared `.git`. The string `--common-dir` does not appear
anywhere in the `gh-stack` source. **[verified]**

The consequences, all reproduced directly:

- A stack created in the main worktree is **invisible** from a linked worktree. Running
  `gh stack view` there exits 2 with `current branch "L2" is not part of a stack` — even
  though `L2` is literally a member of that stack. **[verified]**
- Running `gh stack init` inside a linked worktree writes a *second, independent* state file
  to `.git/worktrees/<name>/gh-stack`. The two stack files never reconcile. **[verified]**

Wooi's whole model is one git worktree per workspace. Under `gh stack` local tracking, every
Wooi workspace would get its own siloed, mutually invisible stack state — which is worse than
having none. Every stack-management command (`init`, `add`, `sync`, `rebase`, `checkout`,
`up`/`down`/`top`/`bottom`, `modify`) depends on that state and is therefore unusable in
Wooi's layout.

GitHub knows this. The extension's own troubleshooting reference has a section titled
**"Driving stacks from another tool or worktree"**, and it names Wooi's exact situation:

> `gh stack link` creates and updates stacks purely through the API, with no local tracking
> state. Use it when branches are managed by jj, Sapling, git-town, **a separate worktree**,
> or any workflow where the local `.git/gh-stack` file would be wrong or absent.

**[verified — `skills/gh-stack/references/troubleshooting.md`]**

So the supported integration path for a tool like Wooi is `link`, not the stack-management
commands. That is a genuinely good outcome: it means Wooi does not have to give up its
worktree model to publish standard stacks.

### 1.3 The data model — and Wooi can read it without the extension

A GitHub stack is a **real server-side object**, not merely an inference over PR base links.
It is exposed on the public GraphQL schema — introspectable today, no preview header:
**[verified]**

```
PullRequest.stack       -> PullRequestStack   "The stack this Pull Request belongs to,
                                               or null if it is not part of a stack"
PullRequest.stackEntry  -> PullRequestStackEntry

PullRequestStack        { id, number, size, baseRefName, entries: PullRequestStackEntryConnection }
PullRequestStackEntry   { id, position, pullRequest, stack }
```

`position` is documented as "this entry's position in the stack, where 1 is the closest to
the base branch". **[verified]**

There is also a REST endpoint that the extension uses and that is **not** in the published
REST documentation index: `GET /repos/{owner}/{repo}/stacks`. It works today and returns
every stack in the repo in one call: **[verified — real response from `cli/cli`]**

```jsonc
[{ "id": 80058, "number": 14025, "node_id": "PRS_kwDODKw3uc4AATi6",
   "base": { "ref": "trunk" }, "open": false, "created_at": "2026-07-31T11:40:59Z",
   "pull_requests": [
     { "number": 13988, "state": "closed", "draft": false,
       "merged_at": "2026-08-01T07:52:47Z",
       "head": { "ref": "williammartin-fix-...", "sha": "b46289c..." } }
   ]}]
```

The extension additionally uses `POST /repos/{o}/{r}/stacks`, `/stacks/{n}/add`, and
`/stacks/{n}/unstack`. **[verified, from binary strings — write behavior not exercised]**

Two conclusions follow.

- **Reads need no extension.** Wooi can answer "is this PR in a GitHub stack, and where?"
  with `gh api graphql` or `gh api repos/{o}/{r}/stacks`, using the `gh` binary it already
  depends on. No new dependency for the read path.
- **A stack is not created implicitly.** Opening PRs chained by base branch — exactly what
  Wooi does today — does **not** produce a GitHub stack object. Querying real chained PRs
  returns `stack: null`. **[verified]** Creating the stack requires an explicit call
  (`gh stack link`/`submit`, or the REST endpoint). Wooi's existing PRs are therefore not
  retroactively stacks, and today's Wooi users see no stack map on github.com.

`GET /repos/youngminnnn/wooi/stacks` returns `[]` rather than an error, so the read endpoint
is live on an ordinary personal repository. **[verified]** Whether the *write* path is gated
on that repo is **[unverified]** — confirming it would mean creating real pull requests.

### 1.4 `gh stack link` semantics

From the bundled command reference: **[verified as documentation; not exercised]**

- Arguments are bottom-to-top; each is a branch name, PR number, or PR URL.
- A numeric first argument is treated as a **stack number** when such a stack exists, letting
  you append to an existing stack without re-listing it: `gh stack link 7 feature-c`.
- Branch arguments are pushed automatically, **non-force** and atomic. Missing PRs are created
  with auto-generated titles and correctly chained bases; existing PRs with a wrong base are
  corrected.
- Stack membership is **additive only** — `link` never removes a PR from a stack.
- `link` writes no local state, so local navigation commands do not work on the result.

Three of these matter a lot to Wooi. The non-force push means `link` cannot clobber a branch
Wooi is managing. The base correction means `link` overlaps with `retargetPr`. And
**additive-only** means Wooi cannot express "this workspace left the stack" through `link` —
that requires `gh stack unstack <n>` (which drops the whole stack) followed by a re-link.

### 1.5 Merge behavior

- `gh stack merge` is **all-or-nothing** across the chosen merge set; if any PR cannot merge,
  none do. `gh pr merge` cannot merge a stack. **[verified as documentation]**
- Merging a lower layer leaves the PRs above open, and they "automatically rebase and
  retarget". **[unverified — changelog claim, not reproduced]**
- A merge queue on the base branch overrides the method flag and the stack is queued instead,
  possibly landing in separate groups. Merge-queue support was still rolling out as of the
  changelog. **[verified as documentation]**

The auto-retarget half of this is **not new** and Wooi already handles it. `cascade.ts`
documents that GitHub auto-retargets children when the base branch is deleted at merge time,
and `cascadeRetarget` already records `'skipped' / already based on <newBase>` for that case.
That logic survives unchanged.

The auto-**rebase** half is the new and dangerous part. See §2.

## 2. Behavioral overlap and conflict

This is the highest-risk area, so it gets the most detail.

### 2.1 The force-push lease collision

Wooi's cascade, after a parent merges, rebases each child locally and pushes with
`git push --force-with-lease origin <branch>` (`restackOnto` in `src/main/git.ts`). The lease
is the safety mechanism: the push is rejected if the remote moved since Wooi last fetched.

If GitHub server-side rebases a stacked child branch on merge, then the remote ref for that
branch is rewritten **by GitHub, without Wooi's involvement**. Wooi's next cascade then does
one of two things, both bad:

1. **The lease fails and the push is rejected.** Wooi surfaces a failed cascade step for a
   stack that GitHub already fixed. Noisy, but safe — the user sees a scary error about work
   that is actually fine.
2. **Wooi rebases first, then pushes successfully, and GitHub rebases too.** The branch gets
   rebased twice onto the same base. With `rerere` disabled this can mean the user resolves
   the same conflict twice; the commits are rewritten twice, invalidating any review comment
   anchored to the old shas.

There is also a plain race: Wooi's cascade is triggered by *detecting* a merge (polling PR
state), while GitHub's rebase is triggered by the merge itself. Wooi is guaranteed to arrive
second, acting on a state GitHub may have already corrected.

**Whether GitHub actually rewrites the remote branch ref, versus only retargeting the PR and
recomputing the diff, is [unverified].** The changelog says "automatically rebase and
retarget"; the engineering post does not describe merge-time behavior at all; nothing in the
extension source settles it. This single question is the gate on how far Wooi can go, and
§7 makes it the first item of the implementation sequence.

### 2.2 The local worktree is the thing GitHub cannot see

Even if the force-push question resolves benignly, a server-side rebase leaves every Wooi
worktree holding the *pre-rebase* branch. The worktree still has the agent's session, possibly
uncommitted changes, and a checked-out branch whose remote counterpart no longer matches.

`cascadeRestackBranchStack` already refuses to rebase a dirty worktree and records
`'uncommitted changes in the worktree — rebase skipped, restack manually'` instead of silently
skipping. That guard is exactly right here and must be preserved. But the new case is worse
than dirty: the branch is *clean and diverged*, which currently reads as "nothing to do".

Wooi needs a distinct state for "GitHub rebased this branch underneath you" — detectable as
"remote ref for my branch is not an ancestor of, and not equal to, my local tip, and I did not
push that". The right response is to tell the user, not to auto-reconcile.

### 2.3 What `cascade.ts` still needs to do

All of it, for the fallback path, and most of it even on the GitHub path:

- **`recoverClosedPr` must stay.** Its deadlock — a child PR closed because its base branch
  was deleted out-of-band, where retarget is refused on a closed PR and reopen is refused
  without the base branch — is a property of GitHub's PR model, not of the stack feature.
  Nothing in `gh stack` addresses it. This is empirically verified behavior documented in
  `cascade.ts`'s header, and the proposal must not regress it.
- **Model B (branch stack inside one worktree) has no GitHub equivalent.** `gh stack` assumes
  one branch per worktree checkout. `cascadeRestackBranchStack` remains the only thing that
  can rebase a chain of branches living in a single worktree.
- **`buildStackFromPrs` stays as the fallback detector**, for repos without the feature and
  for chains never published as a stack. It gains a *higher-priority* sibling that reads the
  real stack object (§3.2).

### 2.4 Where the two would fight

| Wooi does | `gh stack` does | Conflict |
|---|---|---|
| `retargetPr` child → grandparent | `link` corrects bases; server auto-retargets on merge | Benign. Wooi already records `'skipped'` when the base is already correct. |
| `restackOnto` + `--force-with-lease` | `sync` rebases and force-pushes `--atomic` | **Direct.** Never run both. Wooi must not call `sync`. |
| Per-workspace stack state in Wooi's store | `.git/gh-stack` per worktree | **Direct.** Do not create local tracking; use `link`. |
| Merges one PR via `mergePr` | `merge` is atomic across the set | Different semantics; keep them as separate user-facing actions. |

## 3. Proposal

### 3.1 Scope

GitHub's stack becomes a **projection** of Wooi's stack, not the source of truth. Wooi keeps
owning the chain (`parentWorkspaceId` for model A, `ws.stack` for model B) and the cascade.
What changes is that Wooi additionally *publishes* the chain to GitHub so it renders in the
web UI, the CLI, and the mobile app, and *reads* GitHub's stack when adopting work created
elsewhere.

This buys the strategic goal — the stack becomes visible to reviewers who do not use Wooi —
without betting Wooi's core loop on a v0.1.0 preview.

### 3.2 Data model

Add to `Workspace` (all optional, absent on the fallback path):

```ts
/** The GitHub stack this workspace's PR belongs to, when published. */
ghStackNumber?: number | null
/** 1-based position within that stack, as GitHub reports it. */
ghStackPosition?: number | null
/** Last time Wooi reconciled with GitHub's stack object. */
ghStackSyncedAt?: number | null
```

`StackedBranch` gains nothing. Wooi's chain remains branch-and-base based; the GitHub stack
number is workspace metadata, not chain structure.

New module `src/main/ghStack.ts`, wrapping `gh` the same way `github.ts` does:

- `getRepoStacks(repoPath)` → `GET repos/{o}/{r}/stacks`, cached like `listOpenPrs`.
- `getStackForPr(worktreePath, prNumber)` → GraphQL `PullRequest.stack`.
- `linkStack(worktreePath, branches[])` → `gh stack link` bottom-to-top.
- `unstackStack(repoPath, stackNumber)` → `gh stack unstack <n>`.
- `ghStackAvailable(repoPath)` → §4.

Keep `ghStack.ts` strictly separate from `github.ts`. It is the only module allowed to depend
on the extension, so the fallback boundary is one import away from being auditable.

### 3.3 Control flow

**Publish (new).** After Wooi opens or retargets a PR in a chain of ≥2 PRs, and only if the
repo supports stacks and the user opted in, call `linkStack` with the full ordered chain.
`link` is additive and non-force, so this is safe to call repeatedly and idempotent in
practice. It runs **after** Wooi's own PR creation, never instead of it — Wooi keeps
authoring titles and bodies, which `link` would otherwise auto-generate.

**Adopt (extended).** `buildStackFromPrs` keeps its signature and its role. Before it runs,
`ipc.ts` consults `getStackForPr`. If GitHub reports a stack, that ordering wins and
`buildStackFromPrs` is skipped; otherwise the existing base-link reconstruction runs
unchanged. GitHub's stack is *better* input than base links — it survives a retarget that
temporarily breaks the chain, and it carries explicit positions.

**Cascade (unchanged, plus one guard).** `runMergeCascade` keeps doing exactly what it does.
One new pre-step: before rebasing a child, compare the child's remote ref to its local tip. If
the remote is ahead in a way Wooi did not cause, record a new `StackCascadeStep` status rather
than rebasing — the "GitHub rebased underneath you" state from §2.2. This is a small, additive
change that makes the §2.1 collision visible instead of silent.

**Merge (unchanged).** Wooi keeps merging one PR at a time via `mergePr`. `gh stack merge`'s
all-or-nothing semantics are a different product decision — landing five layers in one click
is not obviously what a Wooi user wants when each layer has its own agent session — and it
should not be adopted silently as part of interop. Revisit separately.

### 3.4 Migration

There is nothing to migrate destructively, which is the nice part.

Existing Wooi stacks are chains of PRs with correct bases and no GitHub stack object. They
keep working exactly as they do today; every Wooi feature is driven off `parentWorkspaceId` /
`ws.stack`, not off GitHub state.

Publishing is **opt-in and reversible**:

- A per-repo setting, default off during preview.
- When enabled, existing chains are published lazily — on the next PR create/retarget in that
  chain, not in a migration sweep. A sweep would create N stack objects at once against a
  preview API with no rollback story.
- Turning it off calls `unstackStack` and clears the three new fields. Because `link` is
  additive-only, "unstack then re-link" is the only way to change membership anyway, so this
  path gets exercised routinely and will not rot.

Workspaces whose PRs were adopted from a GitHub stack created outside Wooi are unaffected:
Wooi records `ghStackNumber` and otherwise treats them as any adopted chain.

## 4. Detection and fallback

`gh` is already required for PR features (README, "Requirements"). The extension is a *second*
GitHub dependency and must never become required.

Three tiers, checked in order:

1. **No `gh`, or not connected.** Everything stack-related falls back to plain git and Wooi's
   own state, as today. No change.
2. **`gh` present, extension absent.** Full read-side interop: `getRepoStacks` and
   `getStackForPr` work through `gh api`, so Wooi can *display* and *adopt* GitHub stacks and
   show the stack number. Publishing is unavailable; the UI offers "install `gh stack` to
   publish" rather than failing.
3. **Extension present and repo supports stacks.** Publishing enabled, subject to the opt-in
   setting.

Detection rules:

- Extension presence: `gh stack --version`, exit 0 and a parseable version. Cache per app
  session. Do not shell out on every render.
- Repo support: treat **exit 9** from any `gh stack` invocation as authoritative "not enabled
  here", persist it per repo, and stop offering to publish. Do not probe speculatively — the
  read endpoint returning `[]` does not prove the write path is open.
- Version pinning: record the extension version alongside the cached capability. If it
  changes, re-detect. A v0.1.0 preview will change its output.

**Never call `gh stack sync`, `rebase`, `init`, `add`, `checkout`, `modify`, `push`, or
`submit`.** They either require the per-worktree tracking file Wooi cannot maintain, or they
force-push branches Wooi owns. This should be a lint-visible rule in `ghStack.ts`, not just a
convention — an allowlist of permitted subcommands, with everything else rejected.

One further operational hazard: `gh stack` **branches on whether stdout is a TTY**, and the
bundled skill warns that under a PTY several commands "open a prompt or a full-screen TUI and
block forever". Wooi spawns `gh` with piped stdio from the Electron main process, so Wooi's
own calls are safe. Agents running in Wooi's **terminal** run under a PTY and can hang. Any
permitted invocation must pass the non-interactive flags (`view --json`, `merge --yes`,
`submit --auto`) regardless of how Wooi thinks it is being run.

## 5. The `gh-stack` agent skill

The official skill (`gh skill install github/gh-stack`, or `npx skills add github/gh-stack`)
is a genuinely good document: it covers non-interactive flags, the exit-code table, and the
"driving stacks from another tool or worktree" guidance quoted above. **[verified — read from
`github/gh-stack`, `skills/gh-stack/SKILL.md` v0.1.0]**

It also **conflicts with Wooi**, because it instructs the agent to drive stacks with exactly
the commands Wooi must not use. Its "Core loop" is `gh stack init` → `gh stack add` →
`gh stack submit`; its "Branch placement" section tells the agent to `gh stack down`, edit,
and `gh stack rebase --upstack`. In a Wooi workspace every one of those either exits 2 (the
tracking file is in a different worktree) or, worse, creates a private per-worktree stack file
that then diverges.

Wooi's built-in MCP tools (`create_stacked_workspace`, `check_stacked_work`) express the same
intent in the model that actually matches Wooi's layout: a new workspace with its own worktree
and branch, forked from the current branch.

Proposal:

- **Do not bundle or recommend the skill.** It is correct for its own model and wrong for
  Wooi's.
- **Do not change the MCP tool descriptions to mention it.** They should describe Wooi's
  model, not negotiate with another tool's.
- **Add one defensive line** to `create_stacked_workspace`'s description: stacking is done
  through this tool, not by running `gh stack` in the terminal. This is cheap and heads off
  the case where the skill is installed globally in the user's environment and the agent
  reaches for it. Whether this is worth the token cost in every tool listing is a judgment
  call for whoever implements it.

The one thing genuinely worth borrowing is the skill's `references/stack-design.md` framing of
*how to choose layers*, which is advice Wooi's own agents could use and which is orthogonal to
the command surface.

## 6. Preview risk

The blast radius is small **if and only if** the scope stays as proposed.

- Publishing is additive. If GitHub withdraws the preview, the stack objects vanish and Wooi's
  chains keep working; the only loss is the web-UI stack map. Nothing in Wooi's cascade,
  adoption, or merge path depends on it.
- Reads degrade to `null`/`[]`, which the fallback already treats as "no GitHub stack, use
  `buildStackFromPrs`".
- The extension is v0.1.0 with nine releases in four months and at least one
  documentation/implementation mismatch already (§1.1). Its output format will change. Wooi
  should depend on the *API* (GraphQL and REST) for reads and on the extension only for
  `link`/`unstack`, so most of the surface area is the more stable one.

The risk would be large if Wooi adopted `gh stack sync` as its cascade, or stored GitHub's
stack as the source of truth. Neither is proposed.

Gating is not fully known. The changelog says "rolling out in public preview to all
repositories over the coming days" with no plan or org restriction mentioned **[verified as
documentation]**, and the read endpoint answers on an ordinary personal repo **[verified]**.
But the extension carries an explicit "not enabled for this repository" error and a dedicated
exit code for it, so per-repo gating clearly exists in some form. **[verified]** Treat exit 9
as the ground truth and do not assume availability.

## 7. Open questions

1. **Does a server-side stack merge rewrite the remote refs of the branches above it?** The
   §2.1 collision depends entirely on this. Must be answered before any code is written.
2. If it does rewrite them, does it also update the PR head sha such that existing review
   comments are re-anchored, or are they orphaned?
3. What exactly does exit 9 key off — repo, org, plan, or rollout cohort?
4. Does `gh stack link` on branches whose PRs already have correct chained bases produce any
   PR mutation (a base "correction" that is a no-op) that would show in the PR timeline as
   noise?
5. Does `link` work when the PRs were opened by a different account than the one running it?
   Wooi opens PRs as the connected user, so probably moot, but unconfirmed.
6. Is there a documented, versioned REST or GraphQL mutation for stack creation, so Wooi could
   drop the extension dependency entirely for publishing? Today only the extension's
   undocumented `POST /repos/{o}/{r}/stacks` is known.

## 8. Implementation sequence

1. **Answer question 1.** A throwaway repo, a three-PR stack created with `gh stack link`,
   merge the bottom one, and watch `git ls-remote` on the branches above. Half a day. Nothing
   else starts until this is settled.
2. **Read-side only, no extension.** `ghStack.ts` with `getRepoStacks` / `getStackForPr`, and
   the tier-2 detection. Surface the stack number and GitHub's ordering in `StackPopover`.
   Ships value (adoption gets more reliable) with zero write risk and no new dependency.
3. **The divergence guard** from §3.3 — a new `StackCascadeStep` status for "remote moved
   underneath you", surfaced in `StackSyncBanner`. Valuable on its own merits, independent of
   the rest.
4. **Extension detection and the permitted-subcommand allowlist**, with exit-9 persistence.
5. **Publishing behind the per-repo opt-in**, default off. `linkStack` on PR create/retarget,
   `unstackStack` on opt-out.
6. **Revisit `gh stack merge`** as a separate product decision once the preview stabilizes.

Steps 2 and 3 are worth doing regardless of what happens to the preview. Steps 4 and 5 should
wait for the preview to leave preview, unless question 1 resolves cleanly and there is a
specific user asking for the web-UI stack map.

## 9. Effect on the comparison table

`docs/alternatives.html` and `docs/comparison-sources.json` are **not** edited by this
document — that is a separate change. Three rows would need revisiting if this proposal ships,
and arguably need revisiting *now*, because GitHub shipping the feature changes the landscape
whether or not Wooi adopts it:

- **"Parent merges → children rebased"** — currently claimed Wooi-only. GitHub now claims this
  server-side for stacked PRs. The honest distinction is that Wooi rebases the *local
  worktrees*, which GitHub cannot touch.
- **"Parent merges → child PR bases retargeted"** — currently claimed Wooi-only. GitHub does
  this natively for stacked PRs now. Wooi's version additionally covers PRs that were never
  published as a GitHub stack, and covers the closed-PR deadlock recovery that GitHub does
  not.
- **"Adopt a stack created outside the app"** — the claim gets *stronger* under this proposal
  (Wooi could adopt a stack created by `gh stack`, jj, or Sapling via the stack object), but
  the row's framing should acknowledge that a standard now exists.

Each of these should become a narrower, defensible claim rather than being dropped or left
as-is.
