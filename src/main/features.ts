import { log } from './logger'
import { fetchRemoteText } from './remoteFile'

/**
 * 원격으로 여닫는 기능 플래그.
 *
 * 공지(`notice.json`)와 **파일을 나눠 둔다.** 배달 경로가 같을 뿐 성격이 다르기 때문이다 —
 * 공지는 사용자에게 보이는 일시적 메시지이고 플래그는 운영 상태다. 바꾸는 사람도, 바꾸는
 * 주기도, 잘못됐을 때의 결과도 다르다. 한 파일에 두면 플래그를 고치다 공지를 건드리게 된다.
 *
 * 이 경로를 쓰는 이유는 하나다 — **이미 설치된 모든 버전에 앱 재배포 없이 닿는 방법이
 * 이것뿐**이다. 파일을 커밋하면 그게 곧 배포다.
 */

export interface Features {
  /**
   * 원격 접근(모바일 컴패니언) UI 를 열 것인가.
   *
   * 데스크톱이 먼저 나가고 폰 앱은 스토어 심사를 거쳐 나중에 올라간다. 그 사이에 켤 수 있게
   * 두면 사용자는 페어링 QR 만 보고 막힌다 — 상대가 아직 없다.
   */
  remoteAccess: boolean
}

const DEFAULT_FEATURES_URL = 'https://raw.githubusercontent.com/youngminnnn/wooi/main/features.json'

/** 로컬에서 플래그를 시험할 때 쓰는 탈출구. */
const FEATURES_URL = process.env.WOOI_FEATURES_URL || DEFAULT_FEATURES_URL

/** 확인 주기. 공지와 같다 — "지금 열렸다"가 빨리 반영돼야 한다. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000

/** 첫 확인을 미루는 시간. 창이 뜨는 순간의 네트워크와 경쟁하지 않게. */
const FIRST_CHECK_DELAY_MS = 5_000

/**
 * 플래그를 읽는다. 값이 없거나 boolean 이 아니면 **null** — "모른다" 이고, 그건 "꺼짐" 과
 * 다르다. 부르는 쪽이 마지막으로 알던 값을 유지할 수 있어야, 파일을 못 가져온 순간
 * 이미 쓰던 사람에게서 기능이 사라지지 않는다.
 */
export function parseFeatures(body: string): Features | null {
  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch {
    log.warn('features: 원격 JSON 파싱 실패 — 무시')
    return null
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null
  const remoteAccess = (doc as { remoteAccess?: unknown }).remoteAccess
  return typeof remoteAccess === 'boolean' ? { remoteAccess } : null
}

/** main 엔트리가 한 번 부른다. 값이 바뀔 때마다(그리고 처음 확인될 때) `onChange` 가 불린다. */
export function initFeatures(onChange: (features: Features) => void): void {
  let last: Features | null = null

  const refresh = async (): Promise<void> => {
    const body = await fetchRemoteText(FEATURES_URL, { label: 'features' })
    if (body === null) return
    const next = parseFeatures(body)
    if (next === null) return
    if (last !== null && last.remoteAccess === next.remoteAccess) return
    last = next
    log.info(`features: remoteAccess=${next.remoteAccess}`)
    onChange(next)
  }

  const timer = setTimeout(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), CHECK_INTERVAL_MS)
    interval.unref?.()
  }, FIRST_CHECK_DELAY_MS)
  timer.unref?.()
}
