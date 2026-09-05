import { protocol } from 'electron'
import { ARTIFACT_SCHEME } from '@shared/types'

/**
 * 아티팩트 스킴 등록 — **app ready 전에** 일어나야 하는 유일한 조각.
 *
 * 그래서 함수가 아니라 모듈 본문의 부수효과다. `src/main/index.ts` 가 이 모듈을 import 하는
 * 순간 실행되고, import 는 `applyDevPaths()` 보다도 먼저 평가된다 — 스킴 등록은 경로를 안
 * 건드리므로 그래도 된다. 핸들러 등록은 반대로 ready **뒤**여야 해서 [[main/artifactProtocol]]
 * 로 갈라 뒀다. 한 파일에 두면 둘 중 하나가 반드시 틀린 시점에 불린다.
 *
 * 권한 네 가지의 뜻:
 *  - `standard` — 진짜 origin 을 갖는다(`wooi-artifact://a`). 이게 없으면 opaque origin 이라
 *    CSP 의 `'self'` 가 아무것도 매치하지 않고 우리 자신의 파일조차 못 불러온다.
 *  - `secure` — secure context. 없으면 최신 API 가 조용히 꺼진다.
 *  - `supportFetchAPI`·`corsEnabled` — **`<script type="module">` 이 이걸 요구한다.** 모듈
 *    스크립트는 Fetch 로 CORS 모드로 받아 오기 때문이다. 이걸 켠다고 망이 열리는 것은 아니다 —
 *    아티팩트의 `fetch()` 는 `connect-src 'none'` 이 죽이고, 이 세션에는 다른 스킴 핸들러가
 *    아예 없다. 차단은 CSP 가 하지 스킴 권한이 하지 않는다([[main/artifactProtocol]]).
 *
 * `bypassCSP` 는 당연히 false 로 둔다 — 그게 true 면 이 파일의 나머지가 전부 무의미해진다.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: ARTIFACT_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: false
    }
  }
])
