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

## 브랜치 이름

브랜치는 `<type>/<설명>` 형식이어야 한다(`feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, `revert`, `release`). 규칙의 단일 소스는
`scripts/check-branch-name.mjs` 이고, pre-push 훅과 CI(`ci.yml`)가 이를 공유한다.

- Wooi 워크트리는 `fearless-echidna` 같은 랜덤 이름으로 브랜치를 만든다. 이 이름은 규칙에
  어긋나므로 **origin 에 push 하기 전에 로컬 브랜치 이름부터 바꾼 뒤 push 한다.**

  ```sh
  git branch -m feat/inline-github-login   # 현재 브랜치를 규칙에 맞는 이름으로
  git push -u origin HEAD
  ```

- `git push origin <local>:<type>/<설명>` 으로 원격 이름만 맞추지 말 것. 훅과 CI 는 통과하지만
  로컬/원격 이름이 갈라지고, Wooi 의 restack 은 현재 HEAD 이름으로
  `git push --force-with-lease origin <branch>` 하므로(`src/main/git.ts`) 이후 push 가 어긋난다.
- 이름을 바꿔도 안전하다 — Wooi 는 워크트리 HEAD 를 다시 읽어 워크스페이스의 브랜치를 맞춘다.
  워크트리 디렉터리 이름은 그대로 둬도 된다.
- 이미 규칙에 어긋난 이름으로 push 했다면 새 이름으로 다시 push 하고 예전 원격 브랜치를 지운다.

  ```sh
  git branch -m <new> && git push -u origin <new> && git push origin --delete <old>
  ```

  PR 이 이미 열려 있다면 원격 브랜치를 지우면 PR 도 닫히므로, 그때는 PR 을 새로 여는 편이 낫다.
