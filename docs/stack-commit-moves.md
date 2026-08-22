# Moving a Commit Between Stack Layers

**English** · [한국어](./stack-commit-moves.ko.md)

Wooi stacks pull requests in layers: `feat/schema` → `feat/api` → `feat/ui`. Each pull
request is based on the layer below it, so reviewers can understand and merge one coherent
change at a time. Sometimes a commit lands in the wrong layer: a helper committed on
`feat/ui` really belongs to `feat/api`.

Moving it by hand is a coordinated history rewrite. The commit must be cherry-picked onto
the lower branch, removed from the upper branch, every higher layer must be restacked in
order, and all affected branches must be force-pushed. If those steps run in the wrong
order, an upper pull request can absorb the lower layer's changes into its own diff and the
stack stops separating the work.

Wooi performs that move as one operation, after showing a preview. The first version moves
**one commit down by one layer in a model A stack**.

Claims marked **[verified]** were reproduced with real Git on 2026-08-22 in a throwaway
repository with two worktrees sharing one object database. Claims marked **[unverified]**
come from reading the implementation or are expectations that have not been exercised for
this operation.

## The stack model matters

Wooi has two stack models.

**Model A** is a chain of Wooi workspaces. Every layer has its own Git worktree, and
`parentWorkspaceId` links the child to the workspace below it. The child's `baseBranch` is
the parent's `branch`. This is the model Wooi creates: both `create_stacked_workspace` and
the sidebar's Stack action pass `parentWorkspaceId` to `createWorkspace()` in
`src/main/workspaces.ts`. **[unverified]**

**Model B** is several branches in one worktree, stored in `Workspace.stack`. Wooi does not
create this shape. It detects it from open pull request base links with
`buildStackFromPrs()` in `src/main/stack.ts`; `src/main/ipc.ts` is the one place that assigns
the detected chain to `Workspace.stack`. **[unverified]**

The first version supports model A because it is the stack Wooi actually builds and because
both branches are already checked out in their own worktrees. No checkout switching is
needed for the real layer branches. Model B is the harder case: one worktree would have to
move HEAD between branches and restore it afterward.

## The local rewrite

Let `L0` be the lower branch tip before the move, `U` the upper branch, and `ck` the commit
being moved. Wooi records the original tips, then performs this local sequence:

```text
1) [lower worktree]  git cherry-pick <ck>                                   -> L1
2) [upper worktree]  git branch   wooi/commit-move-<short-ck> <ck>^
                     git checkout wooi/commit-move-<short-ck>
                     git rebase --onto <L1> <L0> wooi/commit-move-<short-ck> -> MID
3) [upper worktree]  git rebase --onto <MID> <ck> <upper branch>
4) [upper worktree]  git branch -D wooi/commit-move-<short-ck>
```

Step 1 copies `ck` into the lower layer. Step 2 replays the commits that originally sat
between `L0` and `ck` onto the new lower tip. Step 3 replays only the commits after `ck`, so
`ck` is absent from the rebuilt upper layer. Step 3 also leaves HEAD on the upper branch,
not detached. **[verified]**

This deliberately uses two `rebase --onto` operations instead of rebasing the upper branch
and trusting Git's automatic patch-id detection to skip a commit already upstream. The
second range starts after `ck`, so the commit is dropped by construction. That remains true
even when conflicts in the lower cherry-pick were resolved by hand and the new commit no
longer has the same patch-id.

The temporary branch is not needed to prevent rebase from detaching HEAD: during a rebase,
`git rev-parse --abbrev-ref HEAD` reports `HEAD` even if the rebase started from a named
branch. **[verified]** It exists so an interrupted operation leaves a visible, named
`wooi/commit-move-*` breadcrumb instead of an unexplained detached HEAD. It is local only
and is never pushed.

The sequence works when `ck` is the oldest, a middle, or the newest commit in the upper
layer. The empty-range rebases at either edge are successful no-ops. **[verified]** After
the move, the moved files appear in the lower layer's diff against its base and disappear
from `lower..upper`; the layer diffs do not mix. **[verified]**

### Failure and rollback

The local rewrite is all-or-nothing. If steps 1–3 fail, Wooi runs the equivalent of:

```text
git rebase --abort
git checkout <upper>
git branch -D <temp>
git cherry-pick --abort
git reset --hard <L0>
```

It also resets the upper branch to its recorded tip and verifies both exact tips, both clean
worktrees, the checked-out upper branch, and deletion of the temporary branch. On a
reproduced conflict, rollback restored both branches to their exact original SHAs and left
both worktrees clean with the temporary branch deleted. **[verified]**

Ordering is a correctness boundary, not an implementation detail. A deliberately broken
run in which step 1's cherry-pick failed but steps 2–3 continued silently deleted `ck` from
**both** branches. **[verified]** Wooi therefore confirms the new lower tip before it starts
the upper rewrite.

## Safety before rewriting history

Moving one commit changes two layer diffs and may change every pull request above them. The
safety checks apply to the complete affected chain, not just the two worktrees that exchange
the commit.

### Remote divergence is checked first

Before any mutation, Wooi compares every affected local branch with its current remote ref
using `detectRemoteDivergence()` from `src/main/cascade.ts`. If any remote moved in a way the
local branch does not contain, nothing starts. **[unverified]**

`--force-with-lease` is not sufficient here. The comment in `cascade.ts` records a
reproduction from 2026-08-12: when a lower pull request in a GitHub stack merges, GitHub
rewrites the remote refs above it with a server-side cascading rebase. The local worktrees
remain clean at their old tips. `restackOnto()` fetches immediately before pushing, which
refreshes the lease baseline to GitHub's new ref; the force-push then succeeds and overwrites
GitHub's rebase. The damage is not merely resolving the same conflict twice. The upper layer
loses its own isolated diff and re-absorbs the merged layer's changes. **[verified in
`src/main/cascade.ts`, 2026-08-12]**

That is why the check asks the remote directly before the rewrite begins instead of relying
on a stale `origin/<branch>` tracking ref or on the push lease.

### Every affected worktree must be clean

Uncommitted changes in any affected worktree block the whole operation. The rewrite uses
hard resets for rollback and rebases every higher layer in sequence; preserving an unknown
dirty state across those operations would be ambiguous. **[unverified]** A running
workspace and a model B workspace also block the operation. **[unverified]**

### The preview comes before the rewrite

The preview names the commit, the lower and upper branches, every higher branch that will be
restacked and force-pushed, and the original tip SHAs. It also shows which paths move from
the upper layer's diff to the lower layer's diff. **[unverified]**

Those file lists are the paths changed by `ck`, not a recomputed post-move diff. The exact
result is only knowable after Git has rewritten the histories. The preview is intentionally
honest about what is known: which files change ownership between the two layer diffs and
which branches will be rewritten.

### Original and resulting tips are reported

Wooi records every affected branch tip before starting and reports the before and after SHAs
in the result, so the user has recovery anchors. **[unverified]** Automatic rollback ends at
the first successful push. After any rewritten branch reaches the remote, Wooi does not try
to roll it back automatically: a second remote rewrite could overwrite a collaborator's new
work. It reports which steps completed and the recorded SHAs instead. **[unverified]**

### Conflicts roll back

The existing restack button intentionally leaves one worktree in a conflicted rebase so the
user can resolve it and continue. A commit move is different: it crosses two worktrees, two
layer branches, and—after the local two-rebase move—may restack several more branches.
Leaving that operation half-finished would require the user to reconstruct which history
each worktree is supposed to hold.

Wooi therefore aborts and rolls back a conflict before the first push instead of handing off
a half-completed rebase. **[unverified]** A conflict often means `ck` depends on commits that
remain in the upper layer. That dependency is information the user needs; it is not merely a
mechanical conflict-resolution chore.

## Updating the rest of the stack

After the lower and upper branches are rebuilt, Wooi force-pushes them in lower-to-upper
order. It then restacks descendants from the nearest child upward, so every layer is replayed
onto the already-updated tip immediately below it. **[unverified]**

The feature reuses `restackOnto()` from `src/main/git.ts` unchanged for those higher layers.
It also reuses `detectRemoteDivergence()` and the `StackCascadeStep` result shape from
`src/main/cascade.ts`, and reports progress through the same `StackOpProgress` channel used
by the existing restack operation. **[unverified]**

GitHub recomputes pull request diffs after the force-pushes, so the rewritten layer diffs are
expected to appear automatically. `cascade.ts` records that review comments re-anchor across
both GitHub's own rebases and external force-pushes. The same behavior is therefore expected
for this operation, but has not been exercised specifically for commit moves. **[unverified]**

## Deliberate limits of the first version

The first version does not attempt to solve adjacent but substantially different problems:

- **Splitting a layer** would need to open another pull request and rewire pull request bases.
  That GitHub-side workflow would make this single operation much larger and harder to review.
- **`git absorb`-style hunk absorption** must decide which existing commit owns each hunk.
  Commit selection is a separate problem from moving a known commit.
- **Model B** needs branch checkout and restoration within one worktree.
- **Moving up or across non-adjacent layers** has different dependency and ordering rules.
- **Moving several commits at once** adds selection order and partial-dependency questions.

Keeping the operation to one known commit, one downward edge, and model A makes its history
rewrite explicit, previewable, and recoverable.
