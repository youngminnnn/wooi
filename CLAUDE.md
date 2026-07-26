# CLAUDE.md

## 개발 환경

- 의존성(`node_modules`)이 설치되어 있지 않으면, 작업 검증 전에 **직접 `npm install`을 실행해 설치**한다. 사용자에게 설치를 요청하지 말 것.
- 코드 변경 후에는 가능하면 `npm run typecheck`로 타입을 검증한다.
- `npm run dev`(패키징 안 된 실행)는 설치된 Wooi 와 데이터가 분리된다 — 설정/트랜스크립트는
  `~/Library/Application Support/Wooi (dev)`, 워크트리는 `~/wooi-dev/workspaces`.
  경로 결정은 `src/main/paths.ts` 한 곳에 모으고, `WOOI_DEV_ISOLATION=0` 으로 격리를 끌 수 있다.

## 명령어

- `npm run dev` — 개발 모드 실행 (electron-vite)
- `npm run build` — 빌드
- `npm run typecheck` — node + web 타입체크
- `npm run dist` — macOS 배포 빌드
