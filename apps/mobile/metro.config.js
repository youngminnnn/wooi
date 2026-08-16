// Expo SDK 57 / Metro. 참고: https://docs.expo.dev/versions/v57.0.0/config/metro/
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../..')
const shared = path.join(repoRoot, 'src/shared')

const config = getDefaultConfig(__dirname)

/**
 * 데스크톱과 **같은 소스 파일**을 쓴다 — 복사하지 않는다.
 *
 * npm workspaces 를 쓰지 않는 이유(계획 E1): 루트를 workspace 루트로 만들면 Electron 앱을
 * apps/desktop 으로 옮겨야 하고 electron.vite/tsconfig 2개/vitest/husky/electron-builder/
 * GitHub workflow 가 전부 흔들린다. 기능과 무관한 대형 리스크다.
 *
 * 대신 경로로 참조한다. `src/shared/{types,remote}.ts` 는 import 가 0개라(테스트로 강제)
 * hoisting 할 것이 없어서 이게 성립한다.
 */
config.watchFolders = [...(config.watchFolders ?? []), shared]

// `@shared` 는 npm 스코프처럼 보여서 extraNodeModules 로는 안전하게 잡히지 않는다
// (Metro 가 `@shared/remote` 전체를 패키지 이름으로 본다). alias 는 접두사로 매칭한다.
config.resolver.alias = { ...(config.resolver.alias ?? {}), '@shared': shared }

/**
 * `src/shared/crypto.ts` 는 `@noble/*` 를 import 하는데, 그 파일은 이 프로젝트 **밖**에 있다.
 * Metro 는 import 하는 파일 위치에서 위로 올라가며 node_modules 를 찾으므로 루트의
 * node_modules 를 보게 되는데, 그 디렉토리는 watchFolders 에 없어서 쓸 수 없다.
 *
 * 루트 node_modules 를 통째로 watch 하는 대신(데스크톱 의존 트리 전체를 감시하게 된다)
 * **모바일 자신의 사본**을 명시적으로 해석 경로에 넣는다. 그래야 공유 코드가 모바일에
 * 설치된 버전을 쓰고, 두 프로젝트가 서로의 트리를 침범하지 않는다.
 *
 * 전제: 루트와 모바일의 @noble 버전이 같아야 한다(둘 다 ^2.2.0). 어긋나면 데스크톱과 폰이
 * 다른 암호 구현을 쓰게 되므로, 한쪽을 올릴 때 다른 쪽도 같이 올린다.
 */
config.resolver.nodeModulesPaths = [
  path.join(__dirname, 'node_modules'),
  ...(config.resolver.nodeModulesPaths ?? [])
]

module.exports = config
