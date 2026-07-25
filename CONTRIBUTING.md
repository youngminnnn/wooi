# Contributing to Wooi

Thanks for your interest in improving Wooi! This guide covers how to set up the
project, the conventions we follow, and how to get a change merged.

> Wooi is an early-stage, single-maintainer project. Please open an issue to
> discuss non-trivial changes before investing a lot of time — it saves everyone a
> round trip.

## Prerequisites

- **macOS (Apple Silicon)** — Wooi is a macOS desktop app and is currently only
  built/tested on Apple Silicon.
- **Node.js 20** — the version pinned in [`.nvmrc`](./.nvmrc) and used in CI. If you
  use `nvm`, run `nvm use`.
- **git** and **`gh` (GitHub CLI)** — required at runtime; `gh` must be signed in.
- **Claude Code**, signed in — Wooi drives it through the Claude Agent SDK and
  reuses its credentials (no separate API key).

## Getting started

```bash
git clone https://github.com/youngminnnn/wooi.git
cd wooi
nvm use            # optional, selects Node 20
npm install        # installs deps + electron binary (postinstall)
npm run dev        # launches the app in development mode (electron-vite)
```

If `node_modules` is missing or `npm run dev` fails to boot Electron, re-run
`npm install` — the `postinstall` step installs the Electron binary and fixes the
`node-pty` spawn-helper permissions.

## Project layout

```
src/
  main/       Electron main process — IPC, git/worktree, Claude session, terminal
    claude/   Claude Agent SDK session + manager
    agent/    agent orchestration
  preload/    contextBridge API exposed to the renderer
  renderer/   React UI (components, zustand store)
  shared/     types shared across processes
scripts/      repo tooling (branch-name gate, setup)
```

## Development workflow

Before opening a PR, make sure the same gates CI runs pass locally. A `husky`
pre-commit / pre-push hook runs `lint-staged` and these checks, but you can run
them by hand:

```bash
npm run typecheck    # node + web TypeScript
npm run lint         # eslint
npm run format:check # prettier (use `npm run format` to auto-fix)
npm test             # vitest unit tests
npm run build        # electron-vite production build
```

### Tests

Unit tests live next to the code they cover as `*.test.ts` and run in a plain
Node environment (no Electron/DOM). See `src/main/git.test.ts` and
`src/main/names.test.ts` for examples. Prefer testing pure, side-effect-free
functions; new logic in `main/` that can be factored into a pure function should
come with a test.

```bash
npm test           # run once
npm run test:watch # watch mode
```

## Branch & commit conventions

Wooi enforces **Conventional Commits**-style prefixes on **branch names**, both
locally (husky pre-push) and in CI. A branch must be named:

```
<type>/<description>
```

where `<type>` is one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, `revert`, `release`.

Examples:

```
feat/inline-github-login
fix/first-message-stall
docs/readme-demo-gif
```

Commit messages should use the same prefixes (e.g. `fix(worktree): …`). Release
commits use the `release:` prefix.

## Opening a pull request

1. Fork the repo and create a branch following the naming rule above.
2. Make your change, with tests where practical.
3. Run the full check list above — CI runs the exact same gates and will block
   otherwise.
4. Open the PR against `main`, fill in the template, and link any related issue.
5. `@youngminnnn` is the code owner and reviews all PRs.

## Reporting bugs & requesting features

Use the GitHub issue templates. For anything security-related, **do not** open a
public issue — see [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
