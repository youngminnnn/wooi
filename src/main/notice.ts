import { app, ipcMain } from 'electron'
import { IPC, type AppNotice, type NoticeLevel } from '@shared/types'
import { log } from './logger'

/**
 * 원격 공지(앱 상단 배너).
 *
 * 목적은 하나다 — **이미 설치된 모든 버전에** 앱 재배포 없이 메시지를 띄우는 것.
 * 그래서 공지는 번들에 들어가지 않고, 리포에 커밋된 JSON 한 장(NOTICE_URL)에서 주기적으로 온다.
 * 파일을 고치면 그게 곧 배포다.
 *
 * 왜 main 에서 받아오나: 프로덕션 렌더러 CSP 가 `connect-src 'self'` 라 렌더러의 원격 fetch 는
 * 애초에 막혀 있다. 받아온 뒤 IPC 로 밀어 준다.
 *
 * 신뢰 경계: 이 JSON 은 앱 밖에서 바뀌는 입력이다. 그래서 `parseNotices` 가 필드 하나하나를
 * 검사하고, 이상한 항목은 통째로 버린다(전체를 실패시키지 않는다). 렌더러도 message 를 그냥
 * 텍스트로만 그리고, 링크는 http/https 로 제한해 외부 브라우저로만 연다.
 */

/** 공지 원본. 리포 기본 브랜치의 파일이므로 커밋 = 배포. */
const DEFAULT_NOTICE_URL = 'https://raw.githubusercontent.com/youngminnnn/wooi/main/notice.json'

/** 로컬에서 공지 문구를 시험해 볼 때 쓰는 탈출구(파일 URL 도 아닌 http 엔드포인트를 가리켜도 된다). */
const NOTICE_URL = process.env.WOOI_NOTICE_URL || DEFAULT_NOTICE_URL

/** 확인 주기. 업데이트(6h)보다 짧다 — 공지는 "지금 알려야 하는 것"이라 반응이 빨라야 한다. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000

/** 첫 확인을 미루는 시간. 창이 뜨는 순간의 네트워크·CPU 와 경쟁하지 않게. */
const FIRST_CHECK_DELAY_MS = 5_000

/** 한 번의 요청에 허용하는 시간. 공지는 급하지 않으니 오래 매달리지 않는다. */
const FETCH_TIMEOUT_MS = 10_000

/** 본문 크기 상한(바이트). 잘못된 URL 이 거대한 응답을 주더라도 메모리를 먹지 않게. */
const MAX_BODY_BYTES = 64 * 1024

/** 배너는 한 줄이다. 이보다 긴 메시지는 레이아웃을 망가뜨리므로 잘라 낸다. */
const MAX_MESSAGE_LEN = 300

/** 한 번에 들고 있을 공지 수 상한(렌더러는 이 중 아직 안 닫은 첫 건만 띄운다). */
const MAX_NOTICES = 10

const LEVELS: readonly NoticeLevel[] = ['info', 'warn', 'critical']

let active: AppNotice[] = []

/** JSON 안의 공지 한 건(파싱 전 원본 모양). 모든 필드가 신뢰할 수 없는 입력이다. */
interface RawNotice {
  id?: unknown
  level?: unknown
  message?: unknown
  link?: unknown
  /** ISO 8601. 이 시각 전에는 안 띄운다. */
  startsAt?: unknown
  /** ISO 8601. 이 시각 후에는 안 띄운다. */
  endsAt?: unknown
  /** 이 버전 이상에서만 노출(포함). 예: '1.2.0' */
  minVersion?: unknown
  /** 이 버전 이하에서만 노출(포함). 구버전 사용자에게만 알릴 때 쓴다. */
  maxVersion?: unknown
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * '1.2.3-beta.1' 같은 문자열을 [1, 2, 3] 으로. prerelease 꼬리표는 무시한다
 * (공지 노출 범위를 정하는 데 그 정도 정밀도는 필요 없고, 무시하는 편이 예측 가능하다).
 *
 * @returns 숫자 세 칸. 숫자를 하나도 못 읽으면 null.
 */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v)
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** a 와 b 를 비교한다. a<b 면 음수, 같으면 0, a>b 면 양수. 못 읽는 값은 0(=같음)으로 본다. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/** ISO 문자열을 epoch ms 로. 비었거나 못 읽으면 null(= 조건 없음). */
function parseTime(v: unknown): number | null {
  if (!isNonEmptyString(v)) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/**
 * 이 공지를 지금, 이 버전에서 띄워야 하는가.
 *
 * 판정을 쓰기(파싱)와 분리해 둔 이유는 테스트 때문이다 — 시각과 버전을 인자로 받으므로
 * 경계 조건을 그대로 찍어 볼 수 있다.
 */
function isVisible(raw: RawNotice, now: number, version: string): boolean {
  const startsAt = parseTime(raw.startsAt)
  if (startsAt !== null && now < startsAt) return false
  const endsAt = parseTime(raw.endsAt)
  if (endsAt !== null && now > endsAt) return false

  if (isNonEmptyString(raw.minVersion) && compareVersions(version, raw.minVersion) < 0) return false
  if (isNonEmptyString(raw.maxVersion) && compareVersions(version, raw.maxVersion) > 0) return false
  return true
}

/** 링크를 검증한다. http/https 가 아니면(file:, javascript: 등) 링크만 떨어뜨린다. */
function parseLink(v: unknown): AppNotice['link'] | undefined {
  if (!v || typeof v !== 'object') return undefined
  const raw = v as { label?: unknown; url?: unknown }
  if (!isNonEmptyString(raw.label) || !isNonEmptyString(raw.url)) return undefined
  try {
    const url = new URL(raw.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return { label: raw.label.trim().slice(0, 40), url: url.toString() }
  } catch {
    return undefined
  }
}

/**
 * 원격 JSON 본문을 화면에 띄울 공지 목록으로 바꾼다.
 *
 * 방어적으로 동작한다: 형식이 깨진 항목은 조용히 버리고, 통째로 깨졌으면 빈 배열을 준다.
 * 공지 하나를 잘못 써서 앱이 이상해지는 일은 없어야 한다.
 *
 * @param body   원격 JSON 문자열
 * @param now    현재 시각(epoch ms)
 * @param version 현재 앱 버전
 */
export function parseNotices(body: string, now: number, version: string): AppNotice[] {
  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch {
    log.warn('notice: 원격 JSON 파싱 실패 — 무시')
    return []
  }
  // 최상위는 { notices: [...] } 를 기대하지만, 배열만 준 형태도 받아 준다.
  const list = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as { notices?: unknown })?.notices)
      ? ((doc as { notices: unknown[] }).notices as unknown[])
      : []

  const out: AppNotice[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const raw = item as RawNotice
    if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.message)) continue
    const id = raw.id.trim()
    // id 는 "닫음" 기억의 열쇠다. 중복이 있으면 첫 건만 살려 두 공지가 한 기억을 공유하지 않게.
    if (seen.has(id)) continue
    if (!isVisible(raw, now, version)) continue

    seen.add(id)
    out.push({
      id,
      level: LEVELS.includes(raw.level as NoticeLevel) ? (raw.level as NoticeLevel) : 'info',
      message: raw.message.trim().slice(0, MAX_MESSAGE_LEN),
      link: parseLink(raw.link)
    })
    if (out.length >= MAX_NOTICES) break
  }
  return out
}

/** 두 목록이 사용자에게 같은 화면을 뜻하는가(불필요한 방송·리렌더를 막는 용도). */
function sameNotices(a: AppNotice[], b: AppNotice[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function fetchNotices(): Promise<AppNotice[] | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(NOTICE_URL, { signal: ctrl.signal, cache: 'no-cache' })
    if (!res.ok) {
      log.warn(`notice: fetch ${res.status}`)
      return null
    }
    const body = await res.text()
    if (body.length > MAX_BODY_BYTES) {
      log.warn('notice: 응답이 너무 큼 — 무시')
      return null
    }
    return parseNotices(body, Date.now(), app.getVersion())
  } catch (err) {
    // 오프라인·DNS 실패·타임아웃은 정상 상황이다. 조용히 지나가고 다음 주기에 다시 시도한다.
    log.info(`notice: fetch 실패 — ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function initNotice(dispatch: (channel: string, payload: unknown) => void): void {
  // 렌더러가 늦게 떠서 방송을 놓쳐도 되도록, 마지막 목록은 언제든 다시 물어볼 수 있게 한다.
  ipcMain.handle(IPC.noticeGetActive, (): AppNotice[] => active)

  const refresh = async (): Promise<AppNotice[]> => {
    const next = await fetchNotices()
    // null 은 "못 가져옴"이다. 이미 띄운 공지를 네트워크 문제로 지우지 않는다.
    if (next && !sameNotices(next, active)) {
      active = next
      log.info(`notice: ${active.length}건 (${active.map((n) => n.id).join(', ') || '없음'})`)
      dispatch(IPC.evtNotice, active)
    }
    return active
  }

  ipcMain.handle(IPC.noticeRefresh, () => refresh())

  setTimeout(() => void refresh(), FIRST_CHECK_DELAY_MS)
  setInterval(() => void refresh(), CHECK_INTERVAL_MS)
}
