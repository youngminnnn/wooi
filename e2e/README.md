# Electron e2e

Build the app, point `WOOI_E2E_HARNESS` at the absolute `wooi-run` harness directory, and run the specs:

```sh
npm run build
WOOI_E2E_HARNESS=/absolute/path/to/wooi-run/harness npm run e2e
```

The runner skips with a visible explanation when the variable is missing or invalid. Playwright is intentionally not in Wooi's `package.json`: the shared harness owns Electron launch, isolation, cleanup, and its Playwright dependency, while this repository owns only version-coupled seed data and specs.

