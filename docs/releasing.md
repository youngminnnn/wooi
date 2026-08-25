# Versioning & Release Policy

**English** · [한국어](./releasing.ko.md)

How Wooi picks version numbers, when it cuts a release, and how a release gets
published. If you only need the decision rule, read [§2](#2-which-number-to-bump).

---

## 1. Version format

Wooi uses **Semantic Versioning syntax with user-facing semantics**:

```
MAJOR . MINOR . PATCH
```

Wooi is an end-user desktop app, not a library — there is no downstream code
compiling against an API, so classic SemVer's "breaking change" definition does
not map cleanly. Instead each number is defined by **what it means to the person
using the app**:

| Number | Meaning | Bumped when |
|---|---|---|
| **MAJOR** | You have to re-learn something, or do something by hand | Session/settings data migrates incompatibly · minimum requirements change (macOS version, required external tooling) · a core workflow is reworked so the old way no longer applies |
| **MINOR** | There's something new | Any user-visible feature or UX change |
| **PATCH** | Same app, fewer problems | Bug fixes, performance, internals |

MAJOR is expected to stay at `1` for a long time. That is the intended
behaviour, not a sign the policy is being ignored — see VS Code, which has
shipped `1.x` for a decade.

The version in `package.json` is the single source of truth. `app.getVersion()`,
the DMG, `latest-mac.yml`, and the git tag all derive from it.

## 2. Which number to bump

> **Rule:** Look at every commit landing in this release.
>
> - Any `feat!:` or `BREAKING CHANGE:` footer → **MAJOR**
> - Otherwise, any `feat:` / `feat(scope):` → **MINOR**
> - Otherwise → **PATCH**

The rule is deliberately mechanical. Version numbers stop carrying information
the moment they become a judgement call, and the failure mode is always the
same: everything quietly becomes a PATCH.

```bash
# List the commits in scope for the next release.
git log --oneline $(git describe --tags --abbrev=0)..main
```

`docs:`, `ci:`, `chore:`, `style:`, `test:`, `build:`, `refactor:`, `perf:` all
count as PATCH. They do **not**, on their own, justify cutting a release at all
— see below.

## 3. When to cut a release

| Situation | Action |
|---|---|
| Only `docs:` / `ci:` / `chore:` accumulated | **Don't release.** Nothing in the shipped binary changed. The landing page updates through GitHub Pages independently. |
| One or more meaningful `feat:` accumulated | Cut a **MINOR**. Roughly weekly is a good rhythm. |
| Crash, data loss, or "can't update" bug | Cut a **PATCH** immediately. |
| Minor `fix:` with a workaround | Let it ride along with the next MINOR. |

Two constraints shape this. Notarization is an Apple server round-trip that
takes minutes per build, and every release prompts every user to restart. Four
releases in one day is noise, not velocity.

## 4. Version numbers are immutable

**A version number that has been published as a GitHub Release is never
reused.** If a release goes out wrong:

- Do **not** delete the tag and re-push it.
- Do **not** re-run the build to overwrite the assets.
- Ship the next PATCH.

Users who already auto-updated hold the old binary. Replacing the assets under
the same tag means two different binaries both reporting the same version, which
makes every subsequent bug report unfalsifiable.

The `--clobber` path in `build.yml` exists **only** for recovering a release
whose assets failed to upload (e.g. notarization failed after the release object
was created). It is not for re-cutting a release users already have.

## 5. Pre-releases

Reserved format, not currently in use:

```
1.1.0-beta.1
```

This is valid SemVer, sorts correctly for `electron-updater`, and lines up with
its `allowPrerelease` flag plus GitHub's pre-release marker. The format is fixed
now so that adopting a beta channel later doesn't require renaming anything
retroactively. Channel separation isn't worth the overhead at the current user
count.

## 6. Update notification strength

A release has to reach users **without them opening Settings to look for it**.
`src/main/updater.ts` does the checking and surfaces results through three
channels.

**When it checks** — once 8s after launch, then every 2 hours, plus on window
focus and on wake from sleep (throttled to at most one check per 30 minutes).
`setInterval` drifts while the Mac sleeps, so the event triggers cover the gap.

**How it tells you**

- **Top banner** — appears as soon as a new version is found (`available`).
  Dismissing it is "not now", not "never": it comes back when the state or
  version changes, or after 8 hours. (This app stays open for days — a banner
  that hides permanently on first dismiss may as well not exist.)
- **OS notification** — only when the window isn't focused. Once when the
  download is `ready`, then once every 24 hours while it's still ignored. This
  is the only channel that reaches someone who isn't looking at the app.
- **Title-bar dot** — the persistent marker on the settings button.

**Read-only install locations** (running from the DMG, App Translocation) keep
checking too. Only the *install* is impossible there, so auto-download is
turned off and the check still runs — the banner and OS notification then say
"a new version is out, download it manually". This was the case where users
were most likely to never learn about a release.

## 7. Release procedure

1. **Verify what you are about to release.** Build, then run the full Electron
   e2e suite with the shared harness:
   ```bash
   npm run build
   WOOI_E2E_HARNESS=/absolute/path/to/wooi-run/harness npm run e2e
   ```
   See [`e2e/README.md`](../e2e/README.md) for what `WOOI_E2E_HARNESS` is and
   how to set it up.
   Confirm the final `[e2e] N passed, M failed` count (or `total` in
   `.wooi-e2e/report.json`) shows that specs actually ran. A missing or invalid
   harness prints `SKIP` and exits 0, so a green exit alone is not enough. Read
   failures from `report.json`; while fixing them, rerun only the failing specs
   with `npm run e2e -- --only <name>`, then run the full suite once more.

   Also run the tests that require real installed CLIs and credentials and are
   otherwise skipped everywhere:
   ```bash
   WOOI_E2E=1 WOOI_E2E_AGENTS=1 WOOI_E2E_CHOICE=1 npx vitest run src/main/claude/session.hooks.e2e.test.ts src/main/claude/session.restart.e2e.test.ts src/main/subagent/run.e2e.test.ts src/main/subagent/choice.e2e.test.ts
   ```
   Do not proceed to the tag until the full e2e suite and these gated tests are
   green.
2. **Decide the number** using [§2](#2-which-number-to-bump).
3. **Open a `release/vX.Y.Z` branch**, bump `version` in `package.json`, and run
   `npm install` so `package-lock.json` follows.
4. **Commit as `release: vX.Y.Z`**, with a body listing user-visible changes
   since the previous tag (this becomes the summary maintainers read later).
5. **Merge to `main`.**
6. **Tag the merge commit and push:**
   ```bash
   git checkout main && git pull
   git tag "v$(node -p "require('./package.json').version")"
   git push origin "v$(node -p "require('./package.json').version")"
   ```
   Deriving the tag from `package.json` avoids the mismatch described below.
7. **`build.yml` takes over** — it verifies the tag matches `package.json`,
   checks signing secrets, builds, signs, notarizes, verifies with `codesign` /
   `stapler` / `spctl`, then creates the GitHub Release with auto-generated
   notes.
8. **The `homebrew-tap` job follows** — it re-downloads the published
   `Wooi-arm64.dmg`, hashes it, renders `build/homebrew/wooi.rb` with the new
   version + `sha256`, and pushes it to `youngminnnn/homebrew-tap` as
   `Casks/wooi.rb`, so `brew install --cask youngminnnn/tap/wooi` lands on the
   new build. It needs a `TAP_TOKEN` secret (a PAT with `contents: write` on the
   tap repo) and **fails the release run if that secret is missing** rather than
   silently leaving `brew` on the previous version.

### The mismatch guard

`electron-builder` builds from `package.json`, not from the tag. If you tag
`v1.1.0` without bumping `package.json`, the build **succeeds** — but the
release is titled `v1.1.0` while the binary and `latest-mac.yml` both say
`1.0.4`, so no existing user ever receives the update. Nothing looks wrong until
someone notices the install base stopped moving.

`build.yml` has a preflight step that fails the build on this mismatch before
notarization burns any time. Don't remove it.

## 8. Possible future automation

[release-please](https://github.com/googleapis/release-please) would fit: the
repo already squash-merges Conventional-Commit-titled PRs, which is exactly its
input. It would take over §2 entirely (no human picks the number), maintain a
`CHANGELOG.md`, and open the version-bump PR and push the tag automatically —
replacing steps 2–6 above.

Worth adopting once release cadence has settled into the weekly rhythm in §3.
Automating first would just freeze whatever the current habits are into a bot.
