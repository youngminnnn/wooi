# Wooi

**병렬 실행은 쉽습니다. 어려운 건 머지까지입니다.**

[English](./README.md) · **한국어**

![Wooi 데모](docs/demo.svg)

Wooi 는 여러 **AI 코딩 에이전트**를 각자 격리된 git worktree 위에서 병렬로 오케스트레이션하는
macOS 데스크톱 앱입니다. 작업 1개당 전용 worktree + 브랜치 + 에이전트 세션이 돌아가며, 모든 세션은
**자동 프롬프트 없이 빈 입력창**으로 시작합니다 — 첫 메시지를 보내기 전까지 아무것도 실행되지 않습니다.

격리된 worktree 에서 에이전트를 돌리는 건 이제 기본입니다. **worktree 는 파일 충돌은 막아도
의존성은 못 풉니다** — 2번 작업이 1번의 스키마 변경 위에서 이어져야 할 때, 격리가 오히려
걸림돌입니다. 게다가 에이전트를 하나 더 돌릴 때마다 rebase 할 브랜치와 리뷰를 기다리는 PR 이
하나씩 늘어납니다. Wooi 는 이어지는 작업을 쌓아 애초에 부딪히지 않게 하고, 리뷰는 읽고 마는
기록이 아니라 그 위에서 작업하는 diff 로 만듭니다.

> **에이전트 지원** — v1.4.0부터 **Claude Code**(Claude Agent SDK 경유)와
> **OpenAI Codex**(Codex CLI 경유)를 모두 지원합니다. 워크스페이스를 만들 때 에이전트를
> 선택하며, 해당 워크스페이스는 이후에도 선택한 에이전트를 유지합니다.

## 왜 Wooi 인가

- 🧱 **이어지는 작업은 충돌하지 않고 쌓입니다** — 다른 도구에서 병렬 브랜치 충돌은 터진 뒤에
  수습합니다. Wooi 의 답은 구조적입니다. 앞선 작업 위에서 이어지는 작업은 기본 브랜치가 아니라
  그 작업의 브랜치에서 분기합니다. 부모가 병합되면 Wooi 가 자식들을 rebase 하고 PR base 를
  옮깁니다. 남은 스택은 충돌 더미가 되는 대신 그대로 유효합니다.
- 🤖 **에이전트가 스스로 쌓습니다** — 워크스페이스는 직접 쌓을 수도 있고, 에이전트가 쌓게 둘 수도
  있습니다. 에이전트는 다른 워크스페이스가 지금 어떤 파일을 건드리고 있는지 **시작하기 전에**
  확인할 수 있고, 방금 끝낸 작업이 리뷰 가능한 한 덩어리면 자기 브랜치 위에 다음 워크스페이스를
  엽니다. 프롬프트 하나가 직접 짜지 않은 3단 PR 스택이 되기도 합니다.
- 🔍 **PR 리뷰를 diff 위에서** — 에이전트가 코드를 빨리 쓸수록 병목은 리뷰로 옮겨갑니다. PR 리뷰는
  어떤 에이전트든 합니다. 없는 건 그 결과를 다룰 화면입니다. 지적이 해당 diff 줄 위에 바로 붙고,
  하나씩 고치고 버리고, 낱개로든 한꺼번에든 게시합니다.
- 🧵 **진짜 병렬** — 리팩터링·기능 추가·버그 수정을 한꺼번에 시작하고, 사이드바 하나에서 셋 다 지켜봅니다.
- 🔒 **기본이 격리** — 작업마다 별도 worktree + 브랜치라, 공유 작업 트리에서 에이전트끼리 충돌하지 않습니다.
- 🚢 **diff 에서 바로 PR 로** — 에이전트가 만든 변경을 브라우저로 옮겨 가지 않고 그 자리에서
  GitHub PR 로 엽니다.
- 🕵️ **텔레메트리 없음** — 자체 서버 없이, 대화 기록은 로컬에만 저장됩니다.

**[최신 릴리스 다운로드 →](https://github.com/youngminnnn/wooi/releases/latest/download/Wooi-arm64.dmg)**

## 설치

Wooi 는 **서명 및 공증(Apple Developer ID)** 된 `.dmg` 로 배포됩니다 — macOS
Gatekeeper 경고 없이 바로 실행됩니다. Apple Silicon 전용입니다.

### Homebrew

```sh
brew install --cask youngminnnn/tap/wooi
```

이걸로 끝입니다 — cask 가 **Wooi.app** 을 **Applications** 에 설치합니다.
거기서 실행한 뒤 온보딩을 진행하세요.

**이미 `.dmg` 로 설치해 두셨다면?** Homebrew 는 자기가 설치하지 않은 앱을 건드리지
않고 `It seems there is already an App at '/Applications/Wooi.app'` 로 멈춥니다.
`--adopt` 를 붙이면 지금 있는 앱을 교체하지 않고 Homebrew 관리로 넘깁니다 — 버전이
달라도 되고, 디스크의 앱은 그대로 둡니다:

```sh
brew install --cask --adopt youngminnnn/tap/wooi
```

### 또는 `.dmg` 직접 받기

1. [최신 `.dmg`](https://github.com/youngminnnn/wooi/releases/latest/download/Wooi-arm64.dmg) 를
   받아 **Wooi** 를 **Applications** 로 드래그합니다. 이전 빌드는
   [Releases 페이지](https://github.com/youngminnnn/wooi/releases)에 있습니다.
2. **Applications** 에서 **Wooi** 를 실행합니다.

## 업데이트

Wooi 는 스스로 업데이트합니다: 실행 시 GitHub Releases 를 확인해 새 버전을
백그라운드로 내려받고, 준비되면 **"Restart to update"** 배너를 띄웁니다.
**설정 → About** 에서 수동으로 확인할 수도 있습니다.

> **v1.0.0 사용 중이신가요?** 이 버전은 자동 업데이트 기능이 들어가기 전이라
> 스스로 갱신되지 않습니다 — Releases 페이지에서 **v1.0.1 이상을 한 번만 수동으로**
> 받아 주세요. v1.0.1 부터는 모든 버전이 자동으로 업데이트됩니다.

## 컨셉

- **Repository** — git 리포를 연결합니다(메인 체크아웃).
- **Workspace** — 작업 1개 = 전용 git worktree + 브랜치 + 에이전트 세션 1개.
  `~/wooi/workspaces/<repo>/<branch>` 에 생성됩니다.
- 각 workspace 는 **독립적·병렬**로 실행됩니다. 한 workspace 에서 에이전트가 돌아가는 동안
  다른 workspace 를 열어 계속 작업할 수 있습니다.
- **Setup / Dev / Archive 스크립트** — 리포 단위로 지정합니다(`npm install`, `npm run dev` 등).
  setup 은 workspace 생성 시 자동 실행(옵션), dev 는 스크립트 패널에서 실행/중지하며,
  archive 는 workspace 를 아카이브할 때 1회 실행됩니다.

## 시작하기

Wooi 를 처음 실행하면 온보딩이 다음을 안내합니다:

1. 약관·개인정보처리방침 **동의**(진행하려면 필수).
2. Claude Code 또는 Codex와 GitHub을 **연결**합니다. 코딩 에이전트는 둘 중 하나만 있으면 됩니다.
   CLI가 없으면 설치 링크를 보여주고, Claude와 Codex 로그인은 앱 안에서 브라우저로 마무리됩니다.
   Codex는 ChatGPT 계정 또는 OpenAI API 키로 연결할 수 있습니다. **GitHub 은 이 단계에서
   건너뛸 수 있습니다** — 바로 작업을 시작하고,
   PR 생성·머지·스택·Check 처럼 GitHub 이 필요한 기능에 처음 닿는 순간에 연결을 요청합니다.
   연결이 끝나면 원래 하려던 동작이 이어서 실행됩니다. 연동 상태는 언제든
   **Settings → Integrations** 에서 변경할 수 있습니다.

Wooi 는 설치된 Claude Code·Codex·`gh` CLI의 로그인 정보를 그대로 사용합니다. Claude 또는
ChatGPT 계정으로 로그인하면 별도 API 키가 필요 없습니다.

### 요구 사항

- macOS(Apple Silicon)
- 다음 중 하나 이상의 코딩 에이전트가 설치되고 로그인된 상태:
  - [Claude Code](https://claude.com/claude-code)
  - [OpenAI Codex CLI](https://developers.openai.com/codex) v0.128.0 이상
    (`npm i -g @openai/codex`)
- `git`
- `gh`(GitHub CLI) — **PR·리뷰·스택 기능에 필요**합니다(PR 생성·머지·닫기, PR 리뷰,
  stacked 브랜치, Check 탭).
  리포 연결·워크스페이스 생성·에이전트 실행·diff·터미널·스크립트 등 `git` 만으로 되는 기능은
  `gh` 없이도 모두 동작합니다.

## 기능

### Workspace

- **기본 프롬프트 없음** — 입력창은 빈 상태로 시작하고, 첫 메시지를 보낼 때 비로소 세션이 시작됩니다.
- **자동 생성** — workspace 는 자동으로 생성된 이름(`witty-otter` 등)을 받고 리포 기본 브랜치에서
  분기됩니다. Settings 에서 **직접 입력**을 켜면 이름·베이스 브랜치를 직접 고를 수 있습니다. 헤더에서
  이름을 더블클릭하면 바꿀 수 있습니다.
- 워크스페이스를 만들 때 **Claude Code 또는 Codex를 선택**합니다. 에이전트별 모델·reasoning
  effort·권한 모드·명령·계정 사용량이 자동으로 표시됩니다. 생성 후에는 에이전트를 바꿀 수 없습니다.
- **모델·reasoning effort 는 workspace 별로 따로 지정**할 수 있습니다. 입력창 위 상태줄에서 고르거나
  `/model`·`/effort` 를 입력해 바꿉니다. 미지정 시 전역 설정을 따르며, 바꿔도 같은 대화를 이어받습니다.
  선택 가능한 모델과 effort 단계는 에이전트와 모델에 따라 달라집니다.
- **앱 재시작 간 세션 resume** — 대화 맥락이 복원되어, 재시작 후 첫 메시지에서 하던 작업을 이어갑니다.

### Stacked PR

모든 작업이 독립적이지는 않습니다 — 2번 작업이 1번 위에서 이어져야 할 때가 있죠. Wooi 는 그
체인을 `git` 과 `gh` 만으로 직접 관리합니다. 별도 스택 도구가 필요 없습니다.

- **워크스페이스 쌓기** — 워크스페이스 메뉴에서 **Stack a new workspace** 를 고르면, 그
  워크스페이스의 브랜치에서 분기한 새 워크스페이스가 생깁니다. PR 은 리포 기본 브랜치가 아니라
  그 부모 브랜치를 대상으로 열립니다.
- **에이전트가 쌓게 두기** — 에이전트는 자기 도구 외에 Wooi 의 도구도 함께 씁니다.
  `check_related_work` 는 이 리포에 열려 있는 다른 워크스페이스와 각각이 바꾸고 있는 파일 경로를
  알려 줍니다(경로만, diff 는 절대 넘기지 않습니다). 충돌을 나중에 수습하는 대신 시작 전에 피할 수
  있습니다. `create_stacked_workspace` 는 방금 끝낸 작업이 리뷰 가능한 한 덩어리일 때 현재 브랜치
  위에 다음 워크스페이스를 열고, `report_to_parent` 로 결과를 부모에게 돌려 줍니다.
- **스택 한눈에 보기** — 현재 워크스페이스가 체인에 속해 있으면 헤더에 **Stack** 버튼이 뜹니다.
  스택의 모든 브랜치를 PR 상태(draft / review required / changes requested / ready to merge /
  conflict / merged), PR 번호, ahead/behind 와 함께 나열합니다. 항목을 클릭해 바로 이동하거나,
  아직 PR 이 없는 브랜치는 그 자리에서 PR 을 열 수 있습니다.
- **Restack** — **Restack onto `<base>`** 는 최신 부모 브랜치 위로 rebase 한 뒤
  `--force-with-lease` 로 push 합니다. 충돌이 나면 worktree 에 그대로 멈춰 있어 거기서
  해결하면 됩니다.
- **병합 캐스케이드** — 부모 PR 이 병합되면, Wooi 가 각 자식 PR 의 base 를 조부모 브랜치로
  옮기고 자식 브랜치를 그 위로 rebase 합니다. 스택 나머지가 충돌 덩어리로 변하지 않고 그대로
  유효하게 남습니다.
- **선언이 아니라 감지** — 에이전트가 UI 를 거치지 않고 `git checkout -b` 와 `gh pr create` 로
  직접 체인을 만들어도, Wooi 가 PR 의 base 링크에서 스택을 복원해 똑같이 보여 줍니다.
- **기본 base 는 누가 열든 부모** — 워크스페이스를 스택으로 만들면 그 브랜치의
  `gh-merge-base` 에 부모를 기록합니다. 그래서 `--base` 없이 그냥 실행한 `gh pr create` 도
  — 사용자가 치든 에이전트가 치든 — 리포 기본 브랜치가 아니라 부모 브랜치를 향합니다.
  그래도 PR 이 엉뚱한 base 로 열렸다면, 그 값을 조용히 받아들여 스택을 잃는 대신
  Wooi 가 알려 주고 리타겟할지 물어봅니다.

### PR 리뷰

에이전트에게 PR 리뷰를 시키는 건 이제 쉽습니다. 어떤 에이전트든 합니다. 어려운 건 돌아온
결과. 채팅 로그에 쌓인 산문 덩어리는 정작 그게 가리키는 코드와 떨어져 있어서 결국 사람이 손으로
리뷰 코멘트로 옮겨 적어야 합니다.

Wooi 는 대신 diff 자체를 작업대로 만듭니다. 리뷰할 PR 은 대개 동료의 것이므로 리뷰는 내 작업의
다음 단계가 아닙니다. 사이드바에 자기 행을 갖고, 워크스페이스 하나를 차지하는 대신 그 옆에서
나란히 돕니다.

- **읽는 로그가 아니라 작업하는 diff** — 3분할입니다. 왼쪽은 변경 파일과 파일별 지적 개수,
  가운데는 diff 전체, 오른쪽은 총평/활동 사이드바. 하단에는 `N inline · M general` 집계가 계속
  떠 있습니다.
- **지적은 해당하는 줄 위에** — 각 지적이 자기 hunk 에 앵커되어 심각도 배지와 마크다운 본문을 단
  카드로 diff 안에 바로 붙습니다. 에이전트가 diff 에 없는 줄을 짚으면 카드가 그 사실과 옮겨진
  위치를 알려 줍니다. 엉뚱한 줄에 달린 코멘트를 나간 뒤가 아니라 나가기 전에 잡습니다.
- **게시 전에 추리기** — **Edit** 로 문장을 그 자리에서 고치고, **Discard** 로 안 달 것을 버리고,
  **Comment** 로 그 지적만 올립니다. 원하는 것만 체크해 한 번에 올릴 수도 있습니다. 각각 개별
  리뷰 코멘트로 나가고, 게시된 카드는 GitHub 코멘트 링크만 남기고 조용해집니다.
- **리뷰 시작** — Overview 보드의 **Review PR** 버튼으로 시작합니다. 리포를 고르고 열려 있는
  PR 을 선택하거나(번호·URL 직접 입력도 됩니다) 무엇을 봐 주면 좋을지 적어 보냅니다.
- **Claude 또는 Codex** — 시작할 때 에이전트를 고릅니다. 리뷰는 시작한 에이전트로 끝까지 돌고,
  후속 질문도 같은 세션을 이어받습니다.
- **전용 worktree** — PR head 를 그 리뷰 전용 worktree
  (`~/wooi/reviews/<repo>/pr-<번호>-<id>`)에 체크아웃합니다. 에이전트가 변경된 hunk
  바깥의 코드를 읽고 트리 전체를 grep 할 수 있으면서, 지금 작업 중인 체크아웃은 건드리지 않습니다.
- **활동 타임라인** — 게시한 코멘트에 달린 답글과 PR 에 올라온 새 커밋을 주기적으로 가져와
  타임라인에 쌓습니다. 이어서 질문하면 리뷰가 그 지점부터 다시 이어집니다.
- **판정** — comment · approve · request changes 를 제출합니다. 아직 안 올린 지적이 있으면 함께
  올릴지 묻고 코멘트를 먼저 게시하며, 하나라도 실패하면 판정은 보류합니다 — 근거 없는 판정만
  올라가지 않도록. 내 PR 에서는 approve/request changes 를 숨기고(GitHub 이 거부합니다),
  그 사이 움직이지 않은 PR 에 같은 판정을 다시 내는 것도 막습니다.
- **영속** — 리뷰는 앱을 껐다 켜도 남고, 아카이브·복원·삭제할 수 있습니다. 삭제하면 리뷰
  worktree 도 함께 정리됩니다.

### 권한

- **Shift+Tab 으로 권한 모드를 순환**합니다. Claude Code는 default·accept edits·plan·auto를,
  Codex는 read only·auto·full access·plan을 제공합니다. 현재 모드는 입력창 아래에 표시됩니다.
- 권한 프롬프트는 Allow/Deny 외에 **"Always allow"**(이 세션 동안 해당 도구 자동 허용)를 제공합니다 —
  Enter=Allow / Esc=Deny.

### 병렬 세션 가시화

- 사이드바에서 **실행 중**(spinner)·**권한 대기**(노란 방패)·**미확인 응답**(파란 점)을 구분해 보여줍니다.
- 창이 비활성이면 완료·에러·권한 요청을 OS 알림으로 띄우고 Dock 배지에 집계합니다.
- 입력창 위 **"Needs input / Next unread"** 버튼으로 사용자 확인이 필요한 세션으로 바로 이동합니다.
- 워크스페이스를 고르지 않았을 때 뜨는 **Overview 보드**에서 모든 활성 세션을 상태별 필터
  (All / Running / Needs input / Unread / Idle)로 훑고 **Stop all** 로 일괄 중단하거나, 카드를
  눌러 바로 진입합니다.

### 작업 영역

위쪽 탭 패널 + 아래쪽 인터랙티브 터미널(크기 조절 가능한 분할):

- **All files** — worktree 파일 트리와 읽기 전용·구문 강조 뷰어.
- **Changes** — base 브랜치 대비 파일별 diff(PR diff 와 같은 의미). 커밋 + staged + unstaged +
  untracked 신규 파일을 모두 포함합니다. 헤더 요약(`N changed · ↑ahead · ↓behind`)으로도 모달로
  열 수 있습니다. PR 이 없고 커밋이 앞서 있으면 **Create PR** 버튼이 브라우저 PR 작성 화면을 엽니다.
- **Check** — 현재 브랜치 PR 의 CI 체크 결과.
- **Terminal** — workspace 별 로그인 셸 터미널. workspace 를 전환했다 돌아와도 실행 중이던 명령과
  셸 상태가 유지됩니다.

### 메시지 작성

- **슬래시 명령 자동완성** — 입력창에 `/` 를 치면 해당 워크스페이스에서 선택한 에이전트가
  지원하는 명령 목록이 뜹니다.
- **파일 멘션** — 입력창에 `@` 를 치면 worktree 를 퍼지 검색해 파일을 메시지에 넣습니다. 에이전트가
  파일을 따로 찾지 않고 바로 내용을 받습니다. 목록에 파일 크기가 함께 뜨고, 에이전트가 잘라
  넣거나 건너뛸 만큼 큰 파일은 경고를 표시합니다. 디렉토리(`@src/`)는 파일 목록이 첨부됩니다.
  **All files** 뷰어의 **Mention** 버튼은 열어 둔 파일을 넣고, 본문을 드래그해 두면 그 구간만
  좁혀서 넣습니다(`@src/app.ts#L40-80`).
- **인라인 셸 명령** — 메시지를 `!` 로 시작하면 worktree 에서 셸 명령으로 실행되고, 결과가 채팅에
  바로 표시됩니다.
- **끌어다 놓기** — 창 어디에든 파일을 떨어뜨리면 이미지는 첨부로, 나머지는 `@` 멘션으로
  들어갑니다. worktree 안의 파일은 상대경로로 줄여 넣습니다.
- **이미지 첨부** — 이미지를 붙여넣거나 끌어다 놓으면 함께 전송됩니다.
- **상태줄** — 브랜치 · 디렉토리 · 모델 · effort · 컨텍스트 사용량이 입력창 위에 항상 표시됩니다.
  대화가 길어지면 **자동 압축**(토글 가능)되며, 수동으로 `/compact` 를 실행할 수도 있습니다.
- **입력 보존·이어쓰기** — 작성 중 메시지는 workspace 전환에도 유지되고, 실행 중에도 후속 메시지를
  큐에 넣을 수 있습니다.
- **단축키** — ↑/↓ 로 이전 메시지를 불러오고, ⌘1–9 / ⌘↑ ⌘↓ 로 workspace 를 전환합니다. ⌘[ 는
  직전에 보던 workspace 로 돌아갑니다.

### 편의 기능

- **Open in editor / Reveal in Finder** — 헤더 버튼으로 worktree 를 VS Code(`code`, 실패 시
  Finder 로 폴백)에서 열거나 Finder 에서 보여줍니다.

> 참고: diff 뷰어는 읽기 전용이라 Wooi 안에서 스테이징·커밋·되돌리기는 할 수 없습니다.

## 개인정보 / 데이터

- Wooi 는 자체 서버가 없고 **분석/텔레메트리를 수집하지 않습니다**.
- 프롬프트·코드는 선택한 에이전트의 제공자에게 전송됩니다: Claude Agent SDK를 통한
  **Anthropic**, 또는 Codex CLI를 통한 **OpenAI**입니다. PR 기능 사용 시 메타데이터는
  `gh` CLI를 통해 **GitHub**으로 전송됩니다.
- 설정·대화 기록은 **로컬**(`~/Library/Application Support/Wooi/`)에만 저장됩니다.
- 자세한 내용은 [`PRIVACY.md`](./PRIVACY.md) · [`TERMS.md`](./TERMS.md) 를 참고해 주세요.

## 소스로 빌드하기

**macOS (Apple Silicon)** 와 **Node.js 24** 가 필요합니다(버전은 [`.nvmrc`](./.nvmrc) 참고).

```bash
git clone https://github.com/youngminnnn/wooi.git
cd wooi
nvm use          # 선택 사항, Node 24 선택
npm install      # 의존성 + Electron 바이너리 설치
npm run dev      # 개발 모드 실행
```

그 밖의 유용한 스크립트:

```bash
npm run typecheck   # node + web 타입체크
npm run lint        # eslint
npm test            # vitest 유닛 테스트
npm run build       # 프로덕션 빌드
npm run dist        # macOS 배포본을 release/ 로 패키징
```

## 기여하기

작은 기여라도 언제든 반갑습니다. 개발 환경 설정·브랜치/커밋 규칙·PR 절차는
**[CONTRIBUTING.md](./CONTRIBUTING.md)** 에 정리해 두었으니 참고해 주세요.
[행동 강령](./CODE_OF_CONDUCT.md)도 함께 지켜 주시면 감사하겠습니다. 보안 이슈는 공개 이슈 대신
[SECURITY.md](./SECURITY.md) 의 절차를 따라 주세요.

## 라이선스

[Apache 2.0](./LICENSE) © youngminnnn. Apache License 2.0 조건에 따라 자유롭게
사용·수정·재배포할 수 있으며, 명시적 특허 사용 허가 조항이 포함되어 있습니다.

"Wooi" 이름과 로고는 상표로서 이 라이선스의 적용을 받지 않습니다
([TRADEMARK.md](./TRADEMARK.md) 참고). 기여자는 첫 PR 병합 전에
[CLA](./CLA.md) 에 서명해 주셔야 합니다.
