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
        // index = 메인 프로세스, host = Agent SDK 쿼리를 실행하는 유틸리티 프로세스(out/main/host.js).
        // 메인이 utilityProcess.fork 로 host.js 를 띄운다 — SDK/스트리밍 fatal 격리용.
        input: {
          index: resolve('src/main/index.ts'),
          host: resolve('src/main/claude/host.ts')
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
