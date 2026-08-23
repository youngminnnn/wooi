# Electron e2e

Build the app, point `WOOI_E2E_HARNESS` at the harness in an **oh-my-wooi source checkout**, and run the specs. The path must be `<oh-my-wooi clone path>/plugins/wooi-run/harness`; the installed plugin snapshot does not contain `harness/`.

```sh
npm run build
WOOI_E2E_HARNESS=/absolute/path/to/oh-my-wooi/plugins/wooi-run/harness npm run e2e
```

Run `npm install` once inside that `harness/` directory if `node_modules` is not present. Playwright lives there and is not tracked. It is intentionally not in Wooi's `package.json`: the shared harness owns Electron launch, isolation, cleanup, and its Playwright dependency, while this repository owns only version-coupled seed data and specs.

When `WOOI_E2E_HARNESS` is not set, the runner reports SKIP and exits 0. When it is set but points to the wrong path, the runner fails and exits 1. A run that actually happened prints `[wooi-run] scratch root: …` once per spec. If that line is absent, the suite did not run; do not read the result as a pass.
