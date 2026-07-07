import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  // 린트 대상에서 제외할 산출물/외부 코드.
  {
    ignores: ['out', 'dist', 'release', 'build', 'node_modules', 'coverage']
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // 메인/프리로드(Node) 코드.
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },

  // 렌더러(React) 코드.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // eslint-plugin-react-hooks v7 이 새로 도입한 opinionated 규칙들은 기존 코드에
      // 다수 걸린다. 핵심 correctness 규칙(rules-of-hooks)만 error 로 강제하고,
      // 나머지는 warn 으로 두어 CI 를 막지 않으면서 점진적으로 정리하도록 신호만 남긴다.
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn'
    }
  },

  // 프로젝트 공통 규칙 조정.
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },

  // 설정 파일 등 빌드 스크립트.
  {
    files: ['*.config.{js,ts}', 'scripts/**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },

  // prettier 와 충돌하는 포맷 규칙 비활성화(항상 마지막).
  prettier
)
