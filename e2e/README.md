# Electron e2e

Build the app, point `WOOI_E2E_HARNESS` at the harness in an **oh-my-wooi source checkout**, and run the specs. The path must be `<oh-my-wooi clone path>/plugins/wooi-run/harness`; the installed plugin snapshot does not contain `harness/`.

```sh
npm run build
WOOI_E2E_HARNESS=/absolute/path/to/oh-my-wooi/plugins/wooi-run/harness npm run e2e
```

Run `npm install` once inside that `harness/` directory if `node_modules` is not present. Playwright lives there and is not tracked. It is intentionally not in Wooi's `package.json`: the shared harness owns Electron launch, isolation, cleanup, and its Playwright dependency, while this repository owns only version-coupled seed data and specs.

When `WOOI_E2E_HARNESS` is not set, the runner reports SKIP and exits 0. When it is set but points to the wrong path, the runner fails and exits 1. A run that actually happened prints `[wooi-run] scratch root: …` once per spec. If that line is absent, the suite did not run; do not read the result as a pass.

Use `--only` repeatedly or with comma-separated names to select specs by a case-insensitive filename substring. Use `--hold` from an interactive terminal to keep the app open until Enter is pressed, including after a failed assertion.

```sh
npm run e2e -- --only startup,slash-commands
npm run e2e -- --only conversation-fork --hold
```

Every run writes a compact result to `.wooi-e2e/report.json`. Screenshots survive cleanup under `.wooi-e2e/shots/<spec-name>/`.

## 새 스펙 쓰는 법

Copy `e2e/specs/_template.mjs` to `<name>.spec.mjs`, then use this checklist:

- Default-export an async function. The runner imports and calls it; throw an error to fail. Include the observed value in assertion errors.
- Seed setup and conversation state with `seedAppState` instead of driving onboarding. Never hardcode schema or terms versions: the fixture reads `CURRENT_SCHEMA_VERSION`, `CURRENT_TERMS_VERSION`, and required `Workspace` fields from the current source. A former seed lagged four schema versions and was silently migrated into an unexpected shape.
- Never start a model turn. Seed transcripts and state, use direct commands, or inject permission events instead.
- Prefer `title` attributes to class names or visible text for selectors. Keep a class selector only when the class or real layout is itself the contract.
- `launchWooi` waits 4 seconds by default for backend detection and git/PR queries. Still wait for the specific UI state when an action starts more asynchronous work.
- A slash autocomplete opened by `/` consumes `Enter`, so append a trailing space to close it before pressing `Enter`, as in `message-status.spec.mjs`, `command-cards.spec.mjs`, and `slash-commands.spec.mjs`.
- Do not use `Escape` to close slash autocomplete. `Composer.tsx` handles an open command-result card first, so the card can consume `Escape` while the autocomplete stays open; the following `Enter` is then eaten by the menu, the command never runs, and the spec times out without naming the cause.
- Raise cards without a model through `sendPermissionRequest(wooi.app, request)`. Target `workspaceId: 'ws-e2e'` (the seeded workspace) so `ChatView` renders it. `kind: 'command'` or `'fileChange'` produces `PermissionPrompt`; `toolName: 'AskUserQuestion'` produces `QuestionPrompt` (normally with `kind: 'question'` and `input.questions`); `kind: 'plan'` produces `PlanPrompt` (with the plan in `input.plan`, and optionally `options`). See `transcript-selection.spec.mjs` for permission and question payloads.
- Built-in MCP tools normally require a model. The exception is a `/wooi:*` command declared as `direct`: the renderer calls the main-process tool directly and renders `JSON.stringify(result, null, 2)` in a temporary `<pre>`. Read and `JSON.parse` that text as in `message-status.spec.mjs`.
- Use e2e for facts jsdom cannot prove: real layout (`getBoundingClientRect`, `getComputedStyle`), real mouse gestures and text selection, and state loaded after an app restart. See `narrow-pane-header.spec.mjs`, `transcript-selection.spec.mjs`, and `message-status.spec.mjs`.
- Iterate with `npm run e2e -- --only <name>`; add `--hold` from an interactive terminal to inspect the window before cleanup. Results go to `.wooi-e2e/report.json`; screenshots go to `.wooi-e2e/shots/<spec-name>/`.
- Open every screenshot and inspect it. A blank frame is the most common false pass.
