import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    // Keep the Claude Agent SDK (and other deps) external so the SDK can resolve
    // its bundled native CLI binary relative to node_modules at runtime.
    plugins: [externalizeDepsPlugin()],
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
})
