# Stack Review

**English** · [한국어](./stack-review.ko.md)

Wooi reviews a chain of stacked pull requests as one unit. The review runs once, sees
every layer's diff at the same time, and answers the questions that only exist at stack
level — whether the layer boundary is in the right place, whether each layer stands on
its own, and whether a finding at the bottom invalidates work at the top.

This document is the design for that feature: what it decides, why, and how it is built.

## Why this is not N reviews

Reviewing each pull request in a stack separately is what every tool does today, Wooi
included. GitHub shipped stacked pull requests to public preview on 2026-07-30 with a
stack map at the top of each PR; the map visualizes the chain but reviews nothing. The
result is that the questions a reviewer actually has about a stack have no owner:

- **Ordering.** Does layer 3 use a symbol, migration, or config value that layer 4 is
  the one to introduce? Then the layers are in the wrong order and layer 3 cannot merge
  on its own.
- **Independence.** Can a reviewer understand layer 2 without reading layer 3? A layer
  that only makes sense once you have read the layer above it is not a layer.
- **Invalidation.** If the reviewer asks for a change at the bottom, what above it has
  to move?
- **Granularity.** Should two layers be one, or one layer be two?
- **Churn.** Does a later layer revert or rewrite something an earlier layer added? That
  work should have been folded down.

Every one of these is a statement about the relationship *between* diffs. A review that
sees one diff cannot produce it, and a review that sees N diffs one after another and
concatenates the results cannot either — by the time it reads layer 4 it has forgotten
layer 3, and nothing in its output has a place to say "these two layers are the same
change split in half."

So the rule for this feature is: **running the existing per-PR review N times and
concatenating the output is not stack review and is not what we build.** The stack-level
questions above are the deliverable. Everything below follows from making them possible.

## Where the stack comes from

Wooi has two stack models and the UI already renders both the same way:

1. A chain of **workspaces**, each in its own worktree, linked by `parentWorkspaceId`.
2. A chain of **branches inside one worktree** (`Workspace.stack`), created by "Split
   here".

Stack review reads membership only through the existing abstractions:

| Source | Abstraction |
| --- | --- |
| Branch stack in one worktree | `workspaceStack(ws)` (`src/shared/types.ts`) |
| Workspace chain | `workspaceStackMembers(all, id)` + `orderByStack()` |
| GitHub's own stack object | `buildStackFromGhStack()` (`src/main/stack.ts`) |
| Open PRs on GitHub (stack made outside Wooi) | `buildStackFromPrs()` (`src/main/stack.ts`) |

`src/main/review/stackResolve.ts` is the only file in the review subsystem that calls
them, and it exposes exactly one shape to the rest of the feature: an ordered list of PR
numbers, bottom first. Nothing downstream knows which model produced the list.

That single point paid for itself before this feature merged. While it was in flight,
#278 landed the read side of GitHub stack interop, and the app's absorption path now asks
GitHub first and falls back to base-link reconstruction. Stack review follows the same
order, and adopting it was one function in `stackResolve.ts` — nothing else in the
subsystem moved.

The order matters more for review than it does for absorption. GitHub reports an explicit
`position` per entry, so a stack survives a moment when a retarget has not landed and the
base chain is briefly broken. Base-link reconstruction does not: with layer 2 still
pointing at `main`, it returns layers 2–3 and silently drops layer 1. A user who set out
to review a stack would review part of one instead, with nothing on screen saying so.
There is a test for exactly that shape.

## Decisions

### One session for the whole stack

A stack review is **one `ReviewSession`** with a list of layers, not one session per
layer with a coordinator above them.

The alternative was considered and rejected on a concrete failure. A coordinating parent
either re-reads every diff itself — in which case the per-layer sessions did nothing —
or it works from their summaries. Working from summaries cannot answer the question the
feature exists for. "Layer 3 line 42 calls `resolveStackAnchor`, which layer 4 is the one
to add" is a claim about a specific line in one diff and a specific hunk in another.
A summary of layer 4 that is short enough to be worth having is too short to contain it.

One session also preserves the reason `ReviewSession` pins `agentBackend`, `model`, and
`effort` at creation: follow-up turns resume the same conversation, and a resumed session
id is only valid on the backend that issued it. With one session there is one conversation
and the rule is unchanged. With N+1 sessions, "continue this review" has no single answer —
the user would have to be asked which layer they meant, for a feature whose entire premise
is that the layers are one thing.

What is genuinely per-PR is GitHub-facing state, so that moves into a per-layer record:

```ts
export interface ReviewLayer {
  prNumber: number
  prUrl: string
  prTitle: string
  prAuthor: string
  /** GitHub blocks approving your own PR — decided per layer, not per stack. */
  viewerIsAuthor: boolean
  /** commit_id for inline comments on this PR. */
  headSha: string
  headRefName: string
  baseRefName: string
  /** Merged layers stay in the record as history but stop being polled or re-read. */
  merged: boolean
  /** Reply-polling watermark for this PR (ISO). */
  lastSeenAt: string | null
  lastSeenHeadSha: string
  /** This layer's own assessment — a verdict per PR needs a body per PR. */
  summary: string
  /** The verdict submitted to this PR. Submission is per PR, so the record is too. */
  lastSubmission: ReviewSubmission | null
}

export interface ReviewSession {
  // …
  /** Bottom first. A single-PR review is a stack of one. */
  layers: ReviewLayer[]
}
```

The last line is the important one. **A single-PR review is a stack of one**, exactly the
way `workspaceStack()` synthesizes a one-entry stack for a workspace that is not stacked.
There is one code path through the manager, the prompt, the anchoring, and the renderer;
the "stack" branch is not a special case bolted onto the side of the normal one, it *is*
the normal one. The reverse — keeping the single-PR path and adding a parallel stack path —
was rejected because the two would drift, and the per-PR path is the one with the tests.

`ReviewSession.prNumber`, `prUrl`, `prTitle`, `prAuthor`, `viewerIsAuthor`, `headSha`,
`baseRefName`, and `lastSubmission` are removed; a schema migration (v20 → v21) folds them
into a one-element `layers`. `normalizeShape()` also fills `layers` for records written by
an older build against an already-migrated file, the same defence added in #267.

Session-level identity — the title in the sidebar, the worktree key — comes from the
**top** of the stack via `stackHead(session)`. The top layer is the last to merge, so it
is the stable name for the review; the bottom is often merged and closed minutes after
approval.

### Context budget

A five-layer stack can be very large, and the model has one context. The budget is a
single total (`MAX_DIFF_CHARS`, 300 000 characters — unchanged, because what is scarce is
context, not pull requests), spent in a fixed order.

**1. The stack skeleton is always sent in full.** For every layer: PR number, title,
base → head, commit subjects, and one line per changed file (`path status +a −d`). For a
five-layer, 200-file stack this is a few kilobytes, and it is the single highest-value
thing in the prompt — the ordering, granularity, and churn questions are mostly answered
from *which layer touches which file*, not from the contents of the hunks. The skeleton
ends with a **cross-layer file table**: every path touched by more than one layer, with
the layers that touch it. That table is the churn question, computed rather than
searched for.

**2. Numbered diffs are allocated by need.** Each layer gets a floor (so no layer is
invisible), then the remainder is distributed in proportion to size. Within a layer,
files that appear in the cross-layer table are emitted first — they carry the questions
that need hunk-level detail. Files that do not fit are listed by name.

**3. Truncation is reported, never silent.** The prompt names every file that was left
out and tells the agent to read it with `git diff <base-ref>...<head-ref> -- <path>` in
the review worktree, which has every layer's head fetched as a local ref. The session
records `truncatedFiles`, and the review screen shows how many files were not inlined.
A review that quietly looked at 60% of a stack and said "looks good" is worse than one
that says what it did not read.

**4. When the skeleton alone does not fit, the review fails to start** with a message
naming the size, rather than sending a prompt that has been cut in half. There is also a
hard cap of **10 layers**; past that the answer is that the stack is the problem.

### Where findings post

Every inline comment must land on the pull request whose diff contains that line. GitHub
returns 422 otherwise — and worse than 422 is the case where the same path and line
number exist in two layers, the comment is accepted, and it lands on the wrong PR.
Anchoring is now the highest-risk part of the feature, so the rules are strict:

- `ReviewAnchor` gains `prNumber`. An anchor without one cannot exist.
- The schema requires `prNumber` on every inline finding, and each file header in the
  rendered diff is prefixed with its PR (`=== [#13] src/main/store.ts (modified)`) so
  the model reads the number off the same line it reads the path off.
- **There is no fallthrough between layers.** If the agent names PR #13 and the file or
  line is not in #13's diff, the finding is demoted to a general finding with the reason
  — it is never retried against #14. Snapping (`SNAP_DISTANCE`, 3 lines) stays inside the
  named layer.
- If the agent omits `prNumber`, resolution looks for layers whose diff contains that
  path. Exactly one match wins. More than one match is resolved only if exactly one of
  them has that line on that side; otherwise the finding is demoted. Guessing between two
  layers that both changed `store.ts` is how a comment ends up on the wrong PR.

**Findings about the stack itself** — "layers 2 and 3 are one change", "layer 3 depends on
layer 4" — belong to no line. They are a separate kind:

```ts
export interface ReviewFinding {
  // …
  anchor: ReviewAnchor | null
  /** Where this posts. For inline findings this equals anchor.prNumber. */
  prNumber?: number
  /** Layers this finding is about. Non-empty only for stack-level findings. */
  stackPrNumbers?: number[]
}
```

A stack-level finding posts as an issue comment on **the lowest layer it names** — the
layer that has to change first, and the one whose author is being asked to act. It is
made unmistakable in the comment itself: `buildFindings` prepends a header line to the
body at construction time,

```
**Stack review** · #12 → #13 → #14

<the agent's text>
```

so the comment still posts verbatim (the existing rule), the user sees exactly what will
go up, and they can edit or delete the header like any other text. This is the same
mechanism the current code already uses when it demotes an inline finding and prepends
its original location.

In the review screen, stack-level findings get their own section above the per-layer
general findings, ordered by the lowest layer they name. They are the point of the
feature; they do not go at the bottom of a list.

### Verdict

`ReviewVerdict` is per pull request on GitHub, and there is no API for approving a chain.
Approving a stack therefore means submitting N reviews. The design does not pretend
otherwise; it makes the fan-out explicit and recoverable.

The submit modal asks for **one decision for the stack** and shows what it will do with
it — a row per layer with the verdict that will be submitted there, each overridable:

- Layers the viewer authored fall back to `comment` and say why (`SELF_REVIEW_BLOCKED`,
  the shared constant). This is per layer: in a stack built by two people, some layers
  are yours and some are not.
- Merged layers are excluded and shown as such.
- The **stack summary posts once**, on the top layer, together with that layer's verdict.
  Other layers get their own per-layer summary from the artifact, prefixed with a pointer
  to where the overall assessment is. Posting the same paragraph on five pull requests is
  spam, and `request-changes` with an empty body is rejected by GitHub.
- Submission is sequential, and **each success is recorded on its own layer**
  (`ReviewLayer.lastSubmission`). If layer 3 fails, layers 1–2 stay submitted, the modal
  reopens showing what is left, and re-submitting sends only the remainder.
  `EMPTY_RESUBMIT_BLOCKED` applies per layer for the same reason it exists today.

### Follow-up turns

`detectNewActivity` and `detectOutdatedComments` are per-PR and stay that way; polling
runs them once per non-merged layer against that layer's own watermark, and activity
items gain `prNumber` so the timeline can label which layer they came from.

The case that matters is the one that does not exist for a single PR: **the author pushes
to layer 1 and everything above rebases**. Every head sha in the stack changes, most
inline comments go outdated, and yet in the common case nothing above layer 1 actually
changed. Re-reading the whole stack there would be expensive and would drown the real
change in noise. So a follow-up turn re-reads on these rules:

1. A head change in layer *i* invalidates layer *i* and **every layer above it** — their
   diffs are computed against a base that moved. Layers below *i* are not refetched.
2. For each invalidated layer above *i*, the newly fetched diff is compared against the
   stored one by content hash. **Identical means a pure restack**: the layer's findings
   are kept, `headSha` is updated (future inline comments need the new `commit_id`), and
   the timeline gets one item — "layers 2–4 were restacked onto the new #12; their diffs
   are unchanged" — instead of three "new commits" items that mean nothing.
3. A layer whose diff actually changed has its unposted findings re-anchored against the
   new diff; anchors that no longer resolve are demoted to general rather than dropped.
   Posted comments are left to GitHub's own outdated flag, which the existing poll reads.
4. A merged layer is marked `merged`, stops being polled, and is excluded from re-reads.
   Its findings and posted comments stay in the record as history.

The follow-up prompt states which layers changed, which merely restacked, and which
merged, on top of the existing "what happened since your review" context. It still does
not resend the diffs — the conversation is resumed, so the model already has them, and
resending would burn context and destabilize its earlier judgements.

### Where it starts

Both entry points, because they answer different questions.

**From the start modal** (`PrReviewStartModal`) — "I have a PR number." After a PR is
picked, `stackResolve` checks whether it belongs to a stack. If it does, the modal shows
the layers and a checkbox, **checked by default**, to review the whole stack. Default-on
is deliberate: reviewing one layer of a stack in isolation is the thing that is wrong
today, and someone who pastes the URL of the middle PR of a five-PR stack has almost
certainly not decided to ignore the other four. The layer list and the cost
(`5 PRs · 62 files`) are visible before starting, and unchecking is one click.

**From `StackPopover`** — "I am looking at a stack." The popover already resolves both
stack models into one row list; a **Review stack** action at its top starts a review over
exactly those rows that have a pull request, and says so when some do not.

Both call the same `startReview({ repoId, prNumbers, … })`. There is no separate
"stack review" entry in the manager.

## Data model changes

| Type | Change |
| --- | --- |
| `ReviewSession` | Per-PR fields removed; `layers: ReviewLayer[]` added (bottom first), `truncatedFiles: number` added |
| `ReviewLayer` | New. Per-PR GitHub state: PR meta, `headSha`, watermarks, `lastSubmission`, `merged` |
| `ReviewAnchor` | `prNumber: number` added — required |
| `ReviewFinding` | `prNumber?: number`, `stackPrNumbers?: number[]` added |
| `ReviewFindingInput` | `prNumber?: number` added |
| `ReviewArtifact` | `layers: { prNumber, summary }[]` and `stack: ReviewFindingInput[]` added |
| `PostedComment` | `prNumber?: number` added — routes replies and outdated checks |
| `ReviewActivityItem` | `prNumber?: number` on reply and commit items |
| `ReviewLayerDiff` | New: `{ prNumber, diff: ReviewDiff }`. `ReviewDiff` itself is unchanged |
| `ReviewBundle` | `diff: ReviewDiff \| null` → `diffs: ReviewLayerDiff[]` |

Optional fields are optional because old records lack them, and the readers treat a
missing value as "the session's only layer". `ReviewDiff`, `ReviewHunk`, `ReviewFileDiff`,
and `DiffRow` are untouched — the per-PR parser is correct and has the tests; multi-PR
support is a container around it, not a change to it.

Sidecar storage keeps its append-based, last-write-wins JSONL. The diff record gains a PR
number and its id becomes `__diff__:<prNumber>` (from the fixed `__diff__`), so each
layer's diff overwrites only itself when refetched. Records written under the old id are
read as the single layer's diff.

The review worktree is **one worktree at the top of the stack**, not one per layer. Every
layer's head is fetched into `refs/wooi/review/<reviewId>/pr-<n>` in a single `git fetch`,
so the agent can run `git diff <base-ref>...<head-ref>` or `git show <ref>:<path>` for any
layer without N checkouts — which is exactly what "what did this file look like before
layer 3 touched it" needs. N worktrees would cost N times the repository on disk and make
"read the file" ambiguous. Disposal deletes the whole `refs/wooi/review/<reviewId>/`
namespace; archive keeps it, for the same reason it does today.

## Prompt strategy

The user's own prompt stays first — it decides the subject of the review; the conventions
below only decide the shape of the answer. Then, in order:

1. **Stack context.** The skeleton described above: ordered layers, the cross-layer file
   table, the local ref name for each layer, and which files were truncated.
2. **The stack questions**, stated as the deliverable and named individually (ordering,
   independence, invalidation, granularity, churn), with the explicit instruction that
   reviewing each PR separately is not the task and that a finding that would be identical
   if the layer were reviewed alone belongs in `inline`, not in `stack`.
3. **Anchoring rules**, unchanged except that `prNumber` is now part of an anchor and is
   copied off the file header rather than inferred.
4. **The output contract.** The existing structured-output schema
   (`outputFormat: { type: 'json_schema' }`, so the CLI retries its own schema violations)
   gains `stack` and `layers`, and `prNumber` becomes required on `inline` items. It keeps
   avoiding nullable unions — optional stays "absent from `required`" — because some schema
   enforcers reject `["integer","null"]`.
5. **The diffs**, per layer, each file header carrying its PR number.

A single-PR review renders the same prompt with one layer. The stack sections collapse to
nothing when there is one layer, so there is one prompt builder and it is exercised by
every review, not only by the rarer stacked ones.

## Implementation sequence

1. **Shared types and stack resolution.** `ReviewLayer`, `ReviewLayerDiff`, anchor and
   finding fields, `stackHead()`/`layerFor()` helpers, `workspaceStackMembers()` lifted
   out of `StackPopover` into `@shared/types`, `stackResolve.ts`, schema migration v21 and
   `normalizeShape`. Tests: stack resolution over both models and over `buildStackFromPrs`;
   migration of a v20 single-PR review.
2. **Review engine.** Multi-ref worktree; `resolveStackAnchor` and the demotion rules;
   diff allocation and the truncation report; the prompt and schema; `buildFindings` over
   layers; manager generalization — start, post routing, per-layer submission, per-layer
   polling, restack detection, follow-up. Tests: anchoring (ambiguous paths, wrong-layer
   `prNumber`, snapping inside a layer), allocation and truncation, restack detection.
3. **Renderer.** Layer grouping in the file list and the diff view, the stack findings
   section, the per-layer submit modal, layer labels on activity, the stack option in the
   start modal, and the `StackPopover` entry point.

All three ship together. The split was considered and rejected once the types were
written: `prNumber` on the anchor, on the finding, and on the viewed-file key is one
design decision, and the renderer reads all three. A first pull request containing only
field declarations, a second that makes them mean something, and a third that makes them
visible would be three PRs that cannot be judged apart — which is exactly the failure this
feature exists to catch.
