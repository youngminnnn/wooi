import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * 아티팩트가 import 할 수 있는 라이브러리를 **한 번에** 굽는다 → `out/artifact/v/*.js`.
 *
 * 앱 렌더러와 그래프를 나눠 놓은 이유가 셋이다:
 *  1. 아티팩트는 별도 origin 이라 앱 번들의 청크를 가리킬 수 없다.
 *  2. 여기 들어간 무게(recharts)가 앱 시작 경로에 얹히면 안 된다.
 *  3. "렌더러 번들은 하나, 창은 `?pane=` 로 가른다" 는 관례([[main/windows]])를 깨지 않는다.
 *
 * react 와 react-dom 이 **같은 빌드**에서 나와야 한다 — 갈라지면 recharts·lucide 가 우리
 * react 와 다른 인스턴스를 잡고, 그 순간 훅이 죽는다. 공유 청크로 모이는지는 빌드 산출물로
 * 확인한다.
 *
 * `NODE_ENV=production` 을 못 박는 것도 필수다. 없으면 React 19 의 dev 빌드가 실려 첫 렌더에
 * `process` 를 참조하다 죽는다 — 게스트에는 `process` 가 없다.
 */
export default defineConfig({
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'out/artifact/v',
    emptyOutDir: true,
    minify: 'esbuild',
    // 게스트는 소스맵을 볼 수 없고(디버거가 없다) 파일만 두 배가 된다.
    sourcemap: false,
    rollupOptions: {
      // 없으면 롤업이 "아무도 안 쓰는 re-export" 로 보고 엔트리를 통째로 털어낸다 —
      // lucide-react 와 recharts 가 0바이트로 나오는 것이 그 증상이다.
      preserveEntrySignatures: 'strict',
      input: {
        react: resolve('src/artifact/vendor/react.js'),
        'react-jsx-runtime': resolve('src/artifact/vendor/react-jsx-runtime.js'),
        'react-dom-client': resolve('src/artifact/vendor/react-dom-client.js'),
        'lucide-react': resolve('src/artifact/vendor/lucide-react.js'),
        recharts: resolve('src/artifact/vendor/recharts.js'),
        mermaid: resolve('src/artifact/vendor/mermaid.js')
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        // 해시에 대문자가 섞이므로 파일 이름 규칙(`shared/artifactUrl`)도 그걸 허용한다.
        chunkFileNames: 'chunk-[hash].js'
      }
    }
  }
})
