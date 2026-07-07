# CLAUDE.md

## 개발 환경

- 의존성(`node_modules`)이 설치되어 있지 않으면, 작업 검증 전에 **직접 `npm install`을 실행해 설치**한다. 사용자에게 설치를 요청하지 말 것.
- 코드 변경 후에는 가능하면 `npm run typecheck`로 타입을 검증한다.

## 명령어

- `npm run dev` — 개발 모드 실행 (electron-vite)
- `npm run build` — 빌드
- `npm run typecheck` — node + web 타입체크
- `npm run dist` — macOS 배포 빌드
