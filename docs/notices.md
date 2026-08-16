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
      "action": { "type": "enableAutoResumeAfterRateLimit", "label": "Enable" },
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
| `action`     | no       | Allowlisted action. Currently only `enableAutoResumeAfterRateLimit`.           |
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
- **Actions are allowlisted.** Remote JSON can select a compiled-in action, never arbitrary settings.

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

## 기능 플래그 (`features`)

같은 파일에 `features` 를 둔다. 공지와 성격은 다르지만 **이미 설치된 모든 버전에 앱 재배포
없이 닿는 경로**가 이것뿐이라 여기 얹는다.

```json
{
  "notices": [],
  "features": { "remoteAccess": false }
}
```

`remoteAccess` 는 원격 접근(모바일 컴패니언) UI 를 열지 말지다. 데스크톱이 먼저 나가고 폰 앱은
스토어 심사를 거쳐 나중에 올라가므로, 그 사이에는 켤 수 있게 두어도 페어링할 상대가 없다 —
사용자는 QR 만 보고 막힌다. 폰 앱이 올라가는 날 이 값을 `true` 로 바꿔 커밋하면 그것이 곧
활성화이고, 데스크톱을 다시 릴리즈하지 않는다.

값이 없거나 boolean 이 아니면 **"모른다"** 로 취급한다. "꺼짐" 과 다르다 — 파일을 못 가져온
것을 꺼짐으로 읽으면, 오프라인이 된 순간 이미 쓰던 사람에게서 기능이 사라진다. 앱은 마지막으로
확인한 값을 기억했다가 그것으로 시작한다.

만드는 사람이 플래그보다 먼저 써야 할 때는 로컬 탈출구가 있다:

```sh
touch "$HOME/Library/Application Support/Wooi/remote-access.enabled"
```

설정 파일이 아니라 별도 파일인 이유는, 설정은 앱이 주기적으로 통째로 덮어써서 앱이 켜져 있는
동안 고치면 지워지기 때문이다.
