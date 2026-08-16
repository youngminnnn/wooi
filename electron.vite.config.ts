import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve('src/shared')

/**
 * 배포본에 구워 넣을 릴레이(Supabase) 설정을 **빌드 시점에** 정한다.
 *
 * 개발과 운영이 서로 다른 **변수 이름**을 읽는 것이 이 함수의 핵심이다:
 *
 *   npm run dev   → WOOI_RELAY_DEV_*   (.env.local, 개발용 프로젝트)
 *   npm run build → WOOI_RELAY_PROD_*  (CI 시크릿, 운영 프로젝트)
 *
 * 이름이 같았다면 내 셸에 떠 있는 개발용 값이 릴리즈 빌드에 조용히 섞일 수 있다.
 * 이름이 다르면 그 사고가 문법적으로 불가능하다 — 릴리즈 빌드는 개발용 변수를 보지 못한다.
 *
 * 값이 없으면 `null` 이고, 그때 앱은 "이 빌드에는 원격이 설정되지 않았다"고 말한다.
 * 조용히 잘못된 릴레이에 붙는 것보다 낫다.
 */
function bakedRelay(command: 'build' | 'serve'): { url: string; anonKey: string } | null {
  const prefix = command === 'serve' ? 'WOOI_RELAY_DEV_' : 'WOOI_RELAY_PROD_'
  const env = loadEnv(command === 'serve' ? 'development' : 'production', process.cwd(), prefix)
  const url = env[`${prefix}URL`]?.trim()
  const anonKey = env[`${prefix}ANON_KEY`]?.trim()
  if (url && anonKey) return { url, anonKey }
  if (url || anonKey) {
    throw new Error(`${prefix}URL 과 ${prefix}ANON_KEY 는 함께 설정해야 합니다.`)
  }
  if (command === 'build') {
    console.warn('[wooi] 릴레이 설정 없이 빌드합니다 — 이 빌드에서는 원격 접근이 꺼집니다.')
  }
  return null
}

export default defineConfig(({ command }) => ({
  main: {
    define: {
      __WOOI_RELAY__: JSON.stringify(bakedRelay(command))
    },
    // Keep the Claude Agent SDK (and other deps) external so the SDK can resolve
    // its bundled native CLI binary relative to node_modules at runtime.
    // toolShim 은 Electron 밖에서 순수 Node 프로세스로 실행된다. 패키징된 앱의 app.asar 안에
    // 있는 node_modules 는 그 프로세스가 읽을 수 없으므로, shim 이 런타임에 쓰는 zod 는
    // main 산출물에 포함해야 한다([[codex/toolShim]]).
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: {
        // index = 메인 프로세스. host/codexHost = 에이전트를 실행하는 유틸리티 프로세스로,
        // 메인이 utilityProcess.fork 로 띄운다 — SDK/스트리밍 fatal 을 메인에서 격리하기 위함이다.
        // 백엔드마다 별도 프로세스라 한쪽이 죽어도 다른 쪽 세션은 살아남는다.
        // delegateServer 는 앞의 셋과 성격이 다르다 — 우리가 fork 하는 것이 아니라 **codex
        // app-server 가** thread 설정을 보고 자식으로 띄우는 stdio MCP 서버다(그래서 소켓으로
        // 메인과 이야기한다). 별도 엔트리로 두어야 그 경로에 실행 가능한 파일이 놓인다.
        input: {
          index: resolve('src/main/index.ts'),
          host: resolve('src/main/claude/host.ts'),
          codexHost: resolve('src/main/codex/host.ts'),
          // toolShim = Codex 용 stdio MCP 서버. 우리가 아니라 `codex app-server` 가 spawn 하므로
          // 반드시 독립 진입점이어야 한다([[codex/toolShim]]).
          toolShim: resolve('src/main/codex/toolShim.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': shared,
        '@': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
}))
