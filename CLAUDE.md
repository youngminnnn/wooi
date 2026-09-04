# CLAUDE.md

## 개발 환경

- 의존성(`node_modules`)이 설치되어 있지 않으면, 작업 검증 전에 **직접 `npm install`을 실행해 설치**한다. 사용자에게 설치를 요청하지 말 것.
- 코드 변경 후에는 가능하면 `npm run typecheck`로 타입을 검증한다.
- `npm run dev`(패키징 안 된 실행)는 설치된 Wooi 와 데이터가 분리된다 — 설정/트랜스크립트는
  `~/Library/Application Support/Wooi (dev)`, 워크트리는 `~/wooi-dev/workspaces`.
  경로 결정은 `src/main/paths.ts` 한 곳에 모으고, `WOOI_DEV_ISOLATION=0` 으로 격리를 끌 수 있다.

## 명령어

- `npm run dev` — 개발 모드 실행 (electron-vite)
- `npm run dev:sandbox` — 이 워크트리의 빌드를 `.wooi-dev/`에 완전히 격리해 실행
  (`--build`는 강제 재빌드, `--fresh`는 저장 상태 초기화). 설치본과 `Wooi (dev)` 데이터는 건드리지 않는다.
- `npm run build` — 빌드
- `npm run typecheck` — node + web 타입체크
- `npm run dist` — macOS 배포 빌드

## 브랜치 이름

브랜치는 `<type>/<설명>` 형식이어야 한다(`feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, `revert`, `release`). 규칙의 단일 소스는
`scripts/branch-name-rule.mjs` 이고, pre-push 훅과 CI(`ci.yml`)가 쓰는
`scripts/check-branch-name.mjs`(CLI)와 앱(`src/main/branchNameFromWork.ts`)이 이를 공유한다.

- Wooi 워크트리는 `fearless-echidna` 같은 랜덤 이름으로 브랜치를 만든다. 이 이름은 규칙에
  어긋나므로 **origin 에 push 하기 전에 이름을 바꿔야 한다.**
- **규칙에 막히면 멈추지 말고 이름을 바꿔 진행한다. 이름은 에이전트가 정한다 — 사용자에게
  묻지 않는다.** 브랜치 이름은 되돌리기 쉽고(개명 뒤에도 워크트리·PR 이 그대로 따라온다)
  재료가 이미 다 나와 있다 — 방금 쓴 커밋과 바꾼 파일이면 충분하다. 여기서 한 번 물어보는 것은
  사용자에게 결정을 넘기는 게 아니라 이미 답이 정해진 질문으로 작업을 멈춰 세우는 것이다.
- **이름 짓는 법** — `<type>/<설명>`. `type` 은 그 작업의 커밋 타입과 맞추고, `설명` 은
  영어 kebab-case 2~4 단어로 *무엇을 했는지* 적는다(워크스페이스 랜덤 이름을 그대로 옮기지
  말 것 — `feat/sleepy-dolphin` 은 규칙만 통과하고 아무것도 알려주지 않는다).
  예: `perf/idle-battery-drain`, `fix/first-message-stall`, `refactor/split-git-module`.
- **`open_pull_request` 도구를 쓰면 손으로 바꿀 필요가 없다.** 아직 push 되지 않은 랜덤 이름
  브랜치면 도구가 push 전에 멈춰 선다(이름을 제안할 때도, 규칙 위반만 알릴 때도 있다).
  어느 쪽이든 위 규칙대로 이름을 정해 `renameBranch` 에 실어 곧바로 다시 부르면 개명 후
  push 한다(빈 문자열이면 그대로 push). 이름을 짓는 별도의 모델 호출은 없다.
- `git push` 를 직접 할 때는 여전히 손으로 바꾼다.

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
