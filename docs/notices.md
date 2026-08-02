# In-app notices

A notice is a one-line banner at the top of the Wooi window, right under the title bar. It exists to
reach **every installed version** — maintenance windows, incidents, a broken release, a deprecation —
without shipping an app update.

The message lives in [`notice.json`](../notice.json) at the repo root. Committing to `main` is the
deploy: installed apps fetch
`https://raw.githubusercontent.com/youngminnnn/wooi/main/notice.json` a few seconds after launch and
every 30 minutes after that.

Users can dismiss a notice with the ✕. Dismissal is permanent **per notice id**, stored locally on
that machine.

## Format

```json
{
  "notices": [
    {
      "id": "2026-08-agent-outage",
      "level": "warn",
      "message": "Anthropic is having an outage — agents may fail to start.",
      "link": { "label": "Status", "url": "https://status.anthropic.com" },
      "startsAt": "2026-08-02T09:00:00Z",
      "endsAt": "2026-08-02T18:00:00Z",
      "minVersion": "1.0.0",
      "maxVersion": "1.2.0"
    }
  ]
}
```

| Field        | Required | Meaning                                                                       |
| ------------ | -------- | ----------------------------------------------------------------------------- |
| `id`         | yes      | Stable identifier. **Never reuse an id** — see below.                          |
| `message`    | yes      | Plain text, one line. Truncated at 300 characters.                             |
| `level`      | no       | `info` (default) · `warn` · `critical`. Picks the banner color and icon.       |
| `link`       | no       | `{ label, url }` button. `http`/`https` only; opens in the external browser.   |
| `startsAt`   | no       | ISO 8601. Hidden before this instant.                                          |
| `endsAt`     | no       | ISO 8601. Hidden after this instant.                                           |
| `minVersion` | no       | Shown only on this app version or newer (inclusive).                           |
| `maxVersion` | no       | Shown only on this app version or older (inclusive) — e.g. "please upgrade".   |

Only the **first** notice that the user hasn't dismissed is shown, so array order is priority. When
there is nothing to say, leave `notices` as `[]`.

## Rules of thumb

- **Never reuse an id.** Dismissal is remembered by id, so anyone who dismissed `v1` would never see
  the new text. Editing the message of a live notice is fine; changing its _meaning_ needs a new id.
- **Write for someone who can't act on it.** A banner interrupts every user of every version.
  Prefer `info`, reserve `critical` for "your work is at risk right now".
- **Set `endsAt`** for anything time-boxed. A stale banner is worse than no banner — expired notices
  disappear on their own.
- **Plain text only.** The message is rendered as text, never as markdown or HTML.

## Testing a notice before you commit it

Point the app at a local file over HTTP:

```sh
python3 -m http.server 8000        # serve the repo root
WOOI_NOTICE_URL=http://localhost:8000/notice.json npm run dev
```

The banner appears ~5 seconds after launch. To see a dismissed notice again, change the id, or clear
the `wooi.noticeDismissed.<id>` key from the renderer's localStorage (DevTools → Application).

## How it works

- `src/main/notice.ts` — fetches, validates, and filters by date/version, then broadcasts
  `evt:notice`. Fetching happens in the main process because the production renderer's CSP is
  `connect-src 'self'`. Malformed entries are dropped individually; a broken file can never break
  the app.
- `src/renderer/src/components/NoticeBanner.tsx` — renders the banner and remembers dismissals via
  `lib/uiFlags.ts`.
