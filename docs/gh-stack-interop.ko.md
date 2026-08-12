# GitHub Stacked Pull Requests 연동

[English](./gh-stack-interop.md) · **한국어**

GitHub 가 2026-07-30 에 stacked pull request 를 public preview 로 내놨다. 이 문서는 그 기능이
실제로 무엇인지, Wooi 의 기존 스택 기능과 어디서 겹치는지, Wooi 가 무엇을 해야 하는지를 정리한
설계 문서다.

**결론: 부분 도입.** Wooi 의 스택을 GitHub 에 발행해 github.com 에서 정식 스택으로 보이게 하고,
스택 정보를 GitHub API 로 되읽는다. `gh stack` 확장의 **로컬 브랜치 추적은 도입하지 않으며**,
캐스케이드 제어를 `gh stack sync` 에 넘기지 않는다. `cascade.ts` 가 계속 엔진이다. 근거는
[결론](#3-제안) 에 있다.

아래 주장은 이 문서 작성자가 2026-08-11 에 `gh stack` v0.1.0 과 실제 GitHub API 로 직접 재현한
것은 **[확인됨]**, 문서만 근거이거나 실제 PR 을 만들지 않고는 실행할 수 없었던 것은
**[미확인]** 으로 표시한다.

## 1. 조사 결과

### 1.1 확장 명령 표면

`gh stack` v0.1.0 은 `gh extension install github/gh-stack` 로 설치한다. 저장소
(`github/gh-stack`)가 공개 MIT 라이선스라서 아래 동작은 바이너리뿐 아니라 소스로도 확인했다.
**[확인됨]**

릴리스 주기는 대략 2주다. v0.0.1(2026-04-10)부터 v0.1.0(2026-07-29)까지 4개월에 9번.
**[확인됨]** 확장은 아직 어리고 계속 움직이고 있다.

명령 목록은 CLI 가 묶은 그대로다. **[확인됨]**

| 그룹 | 명령 |
|---|---|
| 스택 관리 | `add`, `checkout`, `init`, `modify`, `unstack`, `view` |
| 원격 작업 | `link`, `merge`, `push`, `rebase`, `submit`, `sync` |
| 이동 | `bottom`, `down`, `switch`, `top`, `trunk`, `up` |
| 유틸 | `alias`, `feedback` |

이 중 Wooi 에 의미 있는 것은 `link` 와 `merge` 둘뿐이다. 나머지는 Wooi 가 이미 하는 일을
중복하거나, 정면으로 충돌한다.

확장은 동봉한 에이전트 스킬에 종료 코드 표를 문서화해 뒀다. **[스킬 문서 기준 확인됨; 0·2 는
직접 재현]**

| 코드 | 의미 |
|---|---|
| 0 | 성공 |
| 1 | 일반 오류 |
| 2 | 스택에 속하지 않음 |
| 3 | rebase 충돌 |
| 4 | GitHub API 실패 |
| 5 | 잘못된 인자 |
| 6 | 모호해서 판별 불가 |
| 7 | rebase 가 이미 진행 중 |
| 8 | 스택 파일 잠김 |
| 9 | 해당 리포에서 stacked PR 사용 불가 |
| 10 | modify 복구 필요 |

**exit 9 가 기능 게이팅 신호다.** 바이너리에도 대응하는 문자열
`Stacked PRs are not enabled for this repository` 가 들어 있다. **[확인됨]**

기계 판독 출력은 있지만 빈약하다. v0.1.0 의 `gh stack view --json` 이 내보내는 것은 정확히
이것뿐이다. **[확인됨]**

```json
{
  "trunk": "main",
  "currentBranch": "L3",
  "branches": [
    { "name": "L1", "base": "<sha>", "isCurrent": false,
      "isMerged": false, "isQueued": false, "needsRebase": false }
  ]
}
```

없는 것에 주목해야 한다. **PR 번호도, PR URL 도, 스택 번호도, `head` sha 도 없다.** 동봉된
스킬 문서는 `branches[].head` 와 `number`·`url`·`state` 를 담은 `branches[].pr` 객체를
문서화해 뒀는데, 실제 v0.1.0 바이너리는 내보내지 않는다. **[확인됨]** preview 단계의
문서/구현 불일치이고, 결과적으로 `view --json` 만으로는 어떤 브랜치가 어떤 PR 인지 Wooi 가
알 수 없다. 브랜치 이름으로 대조해야 하는데, 그건 확장 없이도 이미 하고 있는 일이다.

`base` 는 **부모 브랜치의 저장된 SHA** 이지 브랜치 이름이 아니며, 낡았을 수 있다.
`needsRebase` 는 "부모 tip 이 더 이상 조상이 아님"을 계산한 플래그다. **[확인됨]**

### 1.2 로컬 추적 상태가 worktree 별로 갈린다 — 이것이 결격 사유다

Wooi 입장에서 가장 중요한 발견이다.

`gh stack` 은 스택 추적 정보를 `<git-dir>/gh-stack` JSON 파일에 저장하고
`<git-dir>/gh-stack.lock` 으로 잠근다. 경로는 `filepath.Join(gitDir, "gh-stack")` 이고
`gitDir` 은 `git rev-parse --git-dir` 이다. **[직접 재현 + `internal/stack/stack.go` 로
확인됨]**

`git rev-parse --git-dir` 은 **worktree 마다 다르다.** 연결된 worktree 에서는 공유 `.git` 이
아니라 `.git/worktrees/<이름>/` 을 가리킨다. `gh-stack` 소스 어디에도 `--common-dir` 문자열이
없다. **[확인됨]**

직접 재현한 결과는 이렇다.

- 메인 worktree 에서 만든 스택이 연결된 worktree 에서는 **보이지 않는다.** 거기서
  `gh stack view` 를 돌리면 `L2` 가 분명히 그 스택의 멤버인데도
  `current branch "L2" is not part of a stack` 과 함께 exit 2 가 난다. **[확인됨]**
- 연결된 worktree 안에서 `gh stack init` 을 돌리면 `.git/worktrees/<이름>/gh-stack` 에
  **두 번째 독립 상태 파일**이 생긴다. 두 파일은 영영 화해하지 않는다. **[확인됨]**

Wooi 의 모델은 워크스페이스마다 worktree 하나다. `gh stack` 로컬 추적을 쓰면 모든 Wooi
워크스페이스가 서로 보이지 않는 각자의 스택 상태를 갖게 된다 — 아예 없는 것보다 나쁘다. 스택
관리 명령(`init`, `add`, `sync`, `rebase`, `checkout`, `up`/`down`/`top`/`bottom`, `modify`)은
전부 그 상태에 의존하므로 Wooi 배치에서는 쓸 수 없다.

GitHub 도 알고 있다. 확장의 트러블슈팅 문서에 **"Driving stacks from another tool or
worktree"** 절이 있고, Wooi 의 상황을 그대로 지목한다.

> `gh stack link` 는 로컬 추적 상태 없이 순전히 API 로만 스택을 만들고 갱신한다. 브랜치를
> jj, Sapling, git-town, **별도 worktree**, 또는 로컬 `.git/gh-stack` 파일이 틀렸거나 없는
> 어떤 워크플로로 관리하든 이때 쓴다.

**[확인됨 — `skills/gh-stack/references/troubleshooting.md`]**

즉 Wooi 같은 도구를 위한 공식 연동 경로는 스택 관리 명령이 아니라 `link` 다. 이건 사실 좋은
소식이다 — 표준 스택을 발행하려고 worktree 모델을 포기할 필요가 없다는 뜻이다.

### 1.3 데이터 모델 — 확장 없이도 읽을 수 있다

GitHub 스택은 PR base 링크를 추론한 결과가 아니라 **실재하는 서버 측 객체**다. 공개 GraphQL
스키마에 노출돼 있고, preview 헤더 없이 지금 introspection 된다. **[확인됨]**

```
PullRequest.stack       -> PullRequestStack   "이 PR 이 속한 스택, 스택에 속하지 않으면 null"
PullRequest.stackEntry  -> PullRequestStackEntry

PullRequestStack        { id, number, size, baseRefName, entries: PullRequestStackEntryConnection }
PullRequestStackEntry   { id, position, pullRequest, stack }
```

`position` 은 "스택 안에서의 위치, 1 이 base 브랜치에 가장 가깝다"로 문서화돼 있다.
**[확인됨]**

확장이 쓰는 REST 엔드포인트도 있는데 공개 REST 문서 색인에는 **없다**:
`GET /repos/{owner}/{repo}/stacks`. 지금 동작하고, 한 번 호출로 리포의 모든 스택을 준다.
**[확인됨 — `cli/cli` 실제 응답]**

```jsonc
[{ "id": 80058, "number": 14025, "node_id": "PRS_kwDODKw3uc4AATi6",
   "base": { "ref": "trunk" }, "open": false, "created_at": "2026-07-31T11:40:59Z",
   "pull_requests": [
     { "number": 13988, "state": "closed", "draft": false,
       "merged_at": "2026-08-01T07:52:47Z",
       "head": { "ref": "williammartin-fix-...", "sha": "b46289c..." } }
   ]}]
```

확장은 그 밖에 `POST /repos/{o}/{r}/stacks`, `/stacks/{n}/add`, `/stacks/{n}/unstack` 도
쓴다. **[바이너리 문자열로 확인됨 — 쓰기 동작은 실행해 보지 않음]**

여기서 두 가지가 따라 나온다.

- **읽기에는 확장이 필요 없다.** Wooi 는 이미 의존하는 `gh` 바이너리로 `gh api graphql` 이나
  `gh api repos/{o}/{r}/stacks` 를 불러 "이 PR 이 GitHub 스택에 속하는가, 몇 번째인가"에
  답할 수 있다. 읽기 경로에는 새 의존성이 없다.
- **스택은 암묵적으로 생기지 않는다.** base 브랜치로 연결한 PR 을 여는 것 — 정확히 Wooi 가
  지금 하는 일 — 만으로는 GitHub 스택 객체가 생기지 않는다. 실제로 연결된 PR 을 조회하면
  `stack: null` 이 온다. **[확인됨]** 스택 생성은 명시적 호출
  (`gh stack link`/`submit`, 또는 REST 엔드포인트)이 있어야 한다. 따라서 Wooi 의 기존 PR 은
  소급해서 스택이 되지 않고, 지금 Wooi 사용자는 github.com 에서 스택 맵을 보지 못한다.

`GET /repos/youngminnnn/wooi/stacks` 는 오류가 아니라 `[]` 를 돌려준다. 평범한 개인 리포에서도
읽기 엔드포인트는 살아 있다는 뜻이다. **[확인됨]** 다만 그 리포에서 **쓰기** 경로까지
열려 있는지는 **[미확인]** 이다 — 확인하려면 실제 PR 을 만들어야 한다.

### 1.4 `gh stack link` 의 의미

동봉된 명령 레퍼런스 기준이다. **[문서로 확인됨; 실행하지 않음]**

- 인자는 아래에서 위 순서다. 각각 브랜치 이름, PR 번호, PR URL 중 하나.
- 첫 인자가 숫자이고 그 번호의 스택이 있으면 **스택 번호**로 해석한다. 기존 목록을 다시
  나열하지 않고 덧붙일 수 있다: `gh stack link 7 feature-c`.
- 브랜치 인자는 자동으로 push 된다 — **force 가 아니고** atomic 이다. PR 이 없으면 자동 생성
  제목으로 만들고 base 를 올바르게 연결하며, base 가 틀린 기존 PR 은 교정한다.
- 스택 멤버십은 **추가만 된다** — `link` 는 PR 을 스택에서 빼지 않는다.
- `link` 는 로컬 상태를 쓰지 않으므로 결과에 대해 로컬 이동 명령은 동작하지 않는다.

이 중 셋이 Wooi 에 크게 중요하다. non-force push 라서 `link` 가 Wooi 가 관리하는 브랜치를
덮어쓸 수 없다. base 교정은 `retargetPr` 과 겹친다. 그리고 **추가만 된다**는 성질 때문에
"이 워크스페이스가 스택에서 빠졌다"를 `link` 로 표현할 수 없다 — 그건
`gh stack unstack <n>`(스택 전체를 없앤다) 뒤 재-link 가 필요하다.

### 1.5 머지 동작

- `gh stack merge` 는 선택한 머지 집합에 대해 **전부 아니면 전무**다. 하나라도 머지할 수
  없으면 아무것도 머지되지 않는다. `gh pr merge` 로는 스택을 머지할 수 없다.
  **[문서로 확인됨]**
- 아래 레이어를 머지하면 위 PR 들은 열린 채로 남고 "자동으로 rebase 되고 retarget 된다".
  **[미확인 — 체인지로그 주장, 재현하지 않음]**
- base 브랜치에 merge queue 가 걸려 있으면 method 플래그를 무시하고 큐에 들어가며, 여러 그룹으로
  나뉘어 착지할 수 있다. 체인지로그 시점에 merge queue 지원은 아직 롤아웃 중이었다.
  **[문서로 확인됨]**

이 중 auto-retarget 쪽은 **새로운 게 아니고** Wooi 가 이미 처리한다. `cascade.ts` 헤더에
머지 시점에 base 브랜치가 지워지면 GitHub 이 자식을 자동 retarget 한다는 것이 적혀 있고,
`cascadeRetarget` 은 그 경우를 `'skipped' / already based on <newBase>` 로 이미 기록한다.
그 로직은 그대로 살아남는다.

auto-**rebase** 쪽이 새롭고 위험한 부분이다. §2 를 보라.

## 2. 동작 중복과 충돌

가장 위험이 큰 영역이라 가장 자세히 쓴다.

### 2.1 force-push lease 충돌

Wooi 의 캐스케이드는 부모가 머지된 뒤 자식을 로컬에서 rebase 하고
`git push --force-with-lease origin <branch>` 로 push 한다(`src/main/git.ts` 의
`restackOnto`). lease 가 안전장치다 — Wooi 가 마지막으로 fetch 한 뒤 원격이 움직였으면 push 가
거부된다.

GitHub 이 머지 시점에 스택 자식 브랜치를 서버에서 rebase 한다면, 그 브랜치의 원격 ref 는
**Wooi 가 개입하지 않은 채 GitHub 이** 다시 쓴 것이다. 그러면 Wooi 의 다음 캐스케이드는 둘 중
하나를 하는데 둘 다 나쁘다.

1. **lease 가 실패해 push 가 거부된다.** GitHub 이 이미 고쳐 놓은 스택에 대해 Wooi 가 실패한
   캐스케이드 단계를 띄운다. 안전하긴 하지만, 멀쩡한 작업에 대해 사용자가 겁나는 오류를 본다.
2. **Wooi 가 먼저 rebase 해서 push 에 성공하고, GitHub 도 rebase 한다.** 같은 base 위로 두 번
   rebase 된다. `rerere` 가 꺼져 있으면 같은 충돌을 두 번 풀어야 하고, 커밋이 두 번 다시
   쓰이면서 옛 sha 에 걸린 리뷰 코멘트가 무효가 된다.

순수한 경합도 있다. Wooi 의 캐스케이드는 머지를 *감지*(PR 상태 폴링)해서 도는데, GitHub 의
rebase 는 머지 그 자체가 방아쇠다. Wooi 는 반드시 늦게 도착하고, GitHub 이 이미 고쳤을 수도
있는 상태에 대고 동작한다.

**GitHub 이 실제로 원격 브랜치 ref 를 다시 쓰는지, 아니면 PR 만 retarget 하고 diff 를 다시
계산하는지는 [미확인] 이다.** 체인지로그는 "automatically rebase and retarget" 이라 하고,
엔지니어링 글은 머지 시점 동작을 아예 다루지 않으며, 확장 소스에도 답이 없다. 이 질문 하나가
Wooi 가 어디까지 갈 수 있는지를 결정하며, §7 은 이것을 구현 순서의 첫 항목으로 둔다.

### 2.2 로컬 worktree 는 GitHub 이 볼 수 없다

§2.1 이 무난하게 풀리더라도, 서버 측 rebase 는 모든 Wooi worktree 에 **rebase 이전** 브랜치를
남긴다. worktree 에는 에이전트 세션이 있고, 커밋 안 한 변경이 있을 수 있으며, 체크아웃된
브랜치의 원격 짝이 더 이상 일치하지 않는다.

`cascadeRestackBranchStack` 은 이미 dirty worktree 를 rebase 하지 않고
`'uncommitted changes in the worktree — rebase skipped, restack manually'` 를 기록한다. 조용히
건너뛰지 않는 그 가드는 여기서도 정확히 옳고 반드시 보존해야 한다. 그런데 새 경우는 dirty
보다 나쁘다 — 브랜치가 **깨끗한데 갈라져 있고**, 지금 코드는 그걸 "할 일 없음"으로 읽는다.

Wooi 에는 "GitHub 이 네 밑에서 이 브랜치를 rebase 했다"는 별도 상태가 필요하다. 판정 조건은
"내 브랜치의 원격 ref 가 내 로컬 tip 의 조상도 아니고 같지도 않은데, 내가 push 하지 않았다"다.
올바른 대응은 자동 화해가 아니라 사용자에게 알리는 것이다.

### 2.3 `cascade.ts` 가 계속 해야 하는 일

폴백 경로에서는 전부, GitHub 경로에서도 대부분 그대로다.

- **`recoverClosedPr` 는 남아야 한다.** base 브랜치가 바깥에서 삭제돼 자식 PR 이 닫히고, 닫힌
  PR 은 retarget 이 거부되고 base 가 없으면 reopen 도 거부되는 그 교착은 스택 기능이 아니라
  GitHub PR 모델의 성질이다. `gh stack` 에는 이걸 다루는 게 없다. `cascade.ts` 헤더에 실측으로
  기록된 동작이고, 이 제안은 그것을 후퇴시키지 않는다.
- **모델 B(worktree 하나 안의 브랜치 스택)에는 GitHub 대응물이 없다.** `gh stack` 은 worktree
  체크아웃마다 브랜치 하나를 가정한다. 한 worktree 안의 브랜치 체인을 rebase 할 수 있는 것은
  `cascadeRestackBranchStack` 뿐이다.
- **`buildStackFromPrs` 는 폴백 감지기로 남는다.** 기능이 없는 리포와, 스택으로 발행된 적 없는
  체인을 위해서다. 여기에 실제 스택 객체를 읽는 *우선순위 높은* 형제가 생긴다(§3.2).

### 2.4 둘이 싸우는 지점

| Wooi 가 하는 일 | `gh stack` 이 하는 일 | 충돌 |
|---|---|---|
| `retargetPr` 로 자식 → 조부모 | `link` 가 base 교정, 머지 시 서버가 auto-retarget | 무해. Wooi 는 base 가 이미 맞으면 `'skipped'` 로 기록한다. |
| `restackOnto` + `--force-with-lease` | `sync` 가 rebase 후 `--atomic` force-push | **정면 충돌.** 둘을 같이 돌리면 안 된다. Wooi 는 `sync` 를 부르지 않는다. |
| Wooi 스토어의 워크스페이스별 스택 상태 | worktree 별 `.git/gh-stack` | **정면 충돌.** 로컬 추적을 만들지 말고 `link` 를 쓴다. |
| `mergePr` 로 PR 하나 머지 | `merge` 는 집합 전체에 대해 atomic | 의미가 다르다. 사용자에게 별개 동작으로 남긴다. |

## 3. 제안

### 3.1 범위

GitHub 스택은 Wooi 스택의 **투영(projection)** 이지 진실의 원천이 아니다. 체인의 소유권
(모델 A 의 `parentWorkspaceId`, 모델 B 의 `ws.stack`)과 캐스케이드는 계속 Wooi 가 갖는다.
달라지는 것은 Wooi 가 체인을 GitHub 에 추가로 *발행* 해서 웹 UI·CLI·모바일 앱에 렌더되게 하고,
바깥에서 만들어진 작업을 흡수할 때 GitHub 의 스택을 *읽는다* 는 점이다.

이것으로 전략적 목표 — Wooi 를 쓰지 않는 리뷰어에게도 스택이 보이는 것 — 는 얻으면서, v0.1.0
preview 에 Wooi 의 핵심 루프를 걸지 않는다.

### 3.2 데이터 모델

`Workspace` 에 추가한다(모두 선택적이고 폴백 경로에서는 없다).

```ts
/** 발행됐을 때, 이 워크스페이스 PR 이 속한 GitHub 스택. */
ghStackNumber?: number | null
/** GitHub 이 알려 준 그 스택 안에서의 1-기반 위치. */
ghStackPosition?: number | null
/** GitHub 스택 객체와 마지막으로 맞춘 시각. */
ghStackSyncedAt?: number | null
```

`StackedBranch` 는 그대로 둔다. Wooi 의 체인은 계속 브랜치·base 기반이고, GitHub 스택 번호는
체인 구조가 아니라 워크스페이스 메타데이터다.

새 모듈 `src/main/ghStack.ts` — `github.ts` 와 같은 방식으로 `gh` 를 감싼다.

- `getRepoStacks(repoPath)` → `GET repos/{o}/{r}/stacks`, `listOpenPrs` 처럼 캐시.
- `getStackForPr(worktreePath, prNumber)` → GraphQL `PullRequest.stack`.
- `linkStack(worktreePath, branches[])` → `gh stack link`, 아래에서 위 순서.
- `unstackStack(repoPath, stackNumber)` → `gh stack unstack <n>`.
- `ghStackAvailable(repoPath)` → §4.

`ghStack.ts` 는 `github.ts` 와 엄격히 분리한다. 확장에 의존해도 되는 유일한 모듈로 두면 폴백
경계가 import 한 줄로 감사 가능해진다.

### 3.3 제어 흐름

**발행(신규).** PR 이 2개 이상인 체인에서 Wooi 가 PR 을 열거나 retarget 한 뒤, 리포가 스택을
지원하고 사용자가 켰을 때만 정렬된 체인 전체로 `linkStack` 을 호출한다. `link` 는 추가만 되고
non-force 라서 반복 호출이 안전하고 사실상 멱등이다. Wooi 의 PR 생성 **뒤에** 돌지, 대신 돌지
않는다 — 제목과 본문은 계속 Wooi 가 쓴다(`link` 에 맡기면 자동 생성된다).

**흡수(확장).** `buildStackFromPrs` 는 시그니처도 역할도 유지한다. 그 앞에서 `ipc.ts` 가
`getStackForPr` 를 먼저 본다. GitHub 이 스택을 알려 주면 그 순서가 이기고
`buildStackFromPrs` 는 건너뛴다. 아니면 기존 base 링크 복원이 그대로 돈다. GitHub 스택은 base
링크보다 *나은* 입력이다 — 체인을 일시적으로 깨는 retarget 에도 살아남고, 명시적 position 을
갖고 있다.

**캐스케이드(그대로, 가드 하나 추가).** `runMergeCascade` 는 하던 일을 그대로 한다. 앞에 한
단계만 넣는다: 자식을 rebase 하기 전에 자식의 원격 ref 와 로컬 tip 을 비교한다. Wooi 가
만들지 않은 방식으로 원격이 앞서 있으면 rebase 하지 말고 새 `StackCascadeStep` 상태를
기록한다 — §2.2 의 "GitHub 이 밑에서 rebase 했다" 상태다. 작고 덧붙이는 변경이며, §2.1 의
충돌을 조용한 것에서 보이는 것으로 바꾼다.

**머지(그대로).** Wooi 는 계속 `mergePr` 로 한 번에 PR 하나씩 머지한다. `gh stack merge` 의
전부-아니면-전무 의미는 별개의 제품 결정이고 — 레이어마다 각자 에이전트 세션이 있는데 다섯
레이어를 한 번에 착지시키는 게 Wooi 사용자가 원하는 것인지 자명하지 않다 — 연동의 곁다리로
조용히 도입할 것이 아니다. 따로 다시 판단한다.

### 3.4 마이그레이션

파괴적으로 옮길 것이 없다는 게 좋은 점이다.

기존 Wooi 스택은 base 가 올바른 PR 체인이고 GitHub 스택 객체가 없는 상태다. 지금 그대로 계속
동작한다. Wooi 의 모든 기능은 GitHub 상태가 아니라 `parentWorkspaceId` / `ws.stack` 으로
움직인다.

발행은 **옵트인이고 되돌릴 수 있다.**

- 리포별 설정, preview 동안 기본값 꺼짐.
- 켜면 기존 체인은 일괄 변환이 아니라 **게으르게** 발행한다 — 그 체인에서 다음 PR 생성/retarget
  이 일어날 때. 일괄 변환은 롤백 story 도 없는 preview API 에 대고 스택 객체 N 개를 한꺼번에
  만드는 일이다.
- 끄면 `unstackStack` 을 부르고 새 필드 3개를 지운다. `link` 가 추가만 되므로 멤버십 변경은
  어차피 "unstack 후 재-link" 뿐이고, 그래서 이 경로는 일상적으로 쓰이며 썩지 않는다.

Wooi 바깥에서 만들어진 GitHub 스택에서 흡수한 워크스페이스는 영향이 없다. Wooi 는
`ghStackNumber` 를 기록하고 나머지는 여느 흡수된 체인과 똑같이 다룬다.

## 4. 감지와 폴백

`gh` 는 이미 PR 기능에 필요하다(README "Requirements"). 확장은 *두 번째* GitHub 의존성이고,
절대 필수가 되면 안 된다.

순서대로 확인하는 3단계다.

1. **`gh` 가 없거나 연결 안 됨.** 스택 관련 전부가 지금처럼 순수 git 과 Wooi 자체 상태로
   폴백한다. 변화 없음.
2. **`gh` 있음, 확장 없음.** 읽기 연동은 완전히 동작한다. `getRepoStacks` 와 `getStackForPr`
   가 `gh api` 로 도니 GitHub 스택을 *표시* 하고 *흡수* 하며 스택 번호를 보여 줄 수 있다.
   발행만 불가하고, UI 는 실패 대신 "발행하려면 `gh stack` 설치"를 안내한다.
3. **확장 있고 리포가 스택 지원.** 옵트인 설정에 따라 발행 가능.

감지 규칙:

- 확장 존재: `gh stack --version` 이 exit 0 이고 버전이 파싱되면. 앱 세션 단위로 캐시한다.
  렌더마다 shell 을 띄우지 않는다.
- 리포 지원: 어떤 `gh stack` 호출이든 **exit 9** 를 "여기선 안 됨"의 최종 근거로 삼고, 리포별로
  기록한 뒤 발행 제안을 멈춘다. 넘겨짚어 탐색하지 않는다 — 읽기 엔드포인트가 `[]` 를 돌려준다고
  쓰기 경로가 열려 있다는 증거는 아니다.
- 버전 고정: 캐시한 지원 여부와 함께 확장 버전을 기록한다. 버전이 바뀌면 다시 감지한다.
  v0.1.0 preview 는 출력이 바뀐다.

**`gh stack sync`, `rebase`, `init`, `add`, `checkout`, `modify`, `push`, `submit` 은 절대
호출하지 않는다.** Wooi 가 유지할 수 없는 worktree 별 추적 파일을 요구하거나, Wooi 가 소유한
브랜치를 force-push 한다. 이건 관례가 아니라 `ghStack.ts` 안에서 눈에 보이는 규칙이어야 한다 —
허용 서브명령 allowlist 를 두고 나머지는 거부한다.

운영상 위험이 하나 더 있다. `gh stack` 은 **stdout 이 TTY 인지로 동작이 갈리고**, 동봉 스킬은
PTY 아래에서 여러 명령이 "프롬프트나 전체 화면 TUI 를 열고 영원히 멈춘다"고 경고한다. Wooi 는
Electron 메인 프로세스에서 stdio 를 파이프로 묶어 `gh` 를 띄우므로 Wooi 자신의 호출은 안전하다.
하지만 Wooi **터미널**에서 도는 에이전트는 PTY 아래라 멈출 수 있다. 허용된 호출은 Wooi 가 어떤
환경이라고 믿든 무관하게 항상 비대화형 플래그(`view --json`, `merge --yes`, `submit --auto`)를
넘겨야 한다.

## 5. `gh-stack` 에이전트 스킬

공식 스킬(`gh skill install github/gh-stack`, 또는 `npx skills add github/gh-stack`)은 꽤 잘
쓴 문서다. 비대화형 플래그, 종료 코드 표, 위에서 인용한 "다른 도구나 worktree 에서 스택
운전하기" 지침을 담고 있다. **[확인됨 — `github/gh-stack` 의 `skills/gh-stack/SKILL.md`
v0.1.0 을 읽음]**

동시에 **Wooi 와 충돌한다.** 에이전트에게 Wooi 가 써서는 안 되는 바로 그 명령으로 스택을
운전하라고 지시하기 때문이다. "Core loop" 가 `gh stack init` → `gh stack add` →
`gh stack submit` 이고, "Branch placement" 절은 `gh stack down` 하고 편집한 뒤
`gh stack rebase --upstack` 하라고 시킨다. Wooi 워크스페이스에서는 이 중 어느 것이든 exit 2 가
나거나(추적 파일이 다른 worktree 에 있다), 더 나쁘게는 worktree 별 스택 파일을 만들어 놓고
갈라진다.

Wooi 의 내장 MCP 도구(`create_stacked_workspace`, `check_stacked_work`)는 같은 의도를 Wooi 의
배치에 실제로 맞는 모델로 표현한다 — 현재 브랜치에서 분기한, 자기 worktree 와 브랜치를 가진 새
워크스페이스.

제안:

- **스킬을 번들하거나 권하지 않는다.** 자기 모델에서는 옳고 Wooi 모델에서는 틀렸다.
- **MCP 도구 설명에 스킬을 언급하도록 바꾸지 않는다.** 도구 설명은 다른 도구와 협상하는 게
  아니라 Wooi 의 모델을 기술해야 한다.
- **방어적인 한 줄만 추가한다** — `create_stacked_workspace` 설명에, 스태킹은 터미널에서
  `gh stack` 을 돌리는 게 아니라 이 도구로 한다고. 싸고, 스킬이 사용자 환경에 전역 설치돼
  에이전트가 그쪽으로 손을 뻗는 경우를 막는다. 모든 도구 목록에 실리는 토큰 비용을 감수할
  가치가 있는지는 구현하는 사람의 판단이다.

정말로 빌려올 만한 것은 스킬의 `references/stack-design.md` 가 정리한 *레이어를 어떻게
나눌 것인가* 라는 관점이다. Wooi 의 에이전트에게도 쓸모 있는 조언이고 명령 표면과 무관하다.

## 6. Preview 리스크

범위를 제안대로 유지하는 **한에서만** 폭발 반경이 작다.

- 발행은 덧붙이기다. GitHub 이 preview 를 거두면 스택 객체가 사라지고 Wooi 의 체인은 계속
  동작한다. 잃는 것은 웹 UI 스택 맵뿐이다. Wooi 의 캐스케이드·흡수·머지 경로 중 어느 것도 여기
  의존하지 않는다.
- 읽기는 `null`/`[]` 로 저하되는데, 폴백은 이미 그것을 "GitHub 스택 없음, `buildStackFromPrs`
  사용"으로 취급한다.
- 확장은 4개월에 9번 릴리스한 v0.1.0 이고 이미 문서/구현 불일치가 하나 있다(§1.1). 출력 형식은
  바뀐다. Wooi 는 읽기를 *API*(GraphQL·REST)에 의존하고 확장은 `link`/`unstack` 에만 쓰는 편이
  좋다. 그러면 표면의 대부분이 더 안정적인 쪽에 놓인다.

Wooi 가 `gh stack sync` 를 캐스케이드로 채택하거나 GitHub 스택을 진실의 원천으로 저장한다면
리스크가 커진다. 둘 다 제안하지 않는다.

게이팅은 완전히 알려져 있지 않다. 체인지로그는 "앞으로 며칠에 걸쳐 모든 리포지터리에 public
preview 로 롤아웃"이라 하고 플랜이나 조직 제한을 언급하지 않으며 **[문서로 확인됨]**, 읽기
엔드포인트는 평범한 개인 리포에서도 응답한다 **[확인됨]**. 하지만 확장에는 명시적인 "이
리포에서 활성화되지 않음" 오류와 전용 종료 코드가 있으니 어떤 형태로든 리포별 게이팅이 분명히
존재한다. **[확인됨]** exit 9 를 근거로 삼고 사용 가능하다고 가정하지 않는다.

## 7. 남은 질문

1. **서버 측 스택 머지가 그 위 브랜치들의 원격 ref 를 다시 쓰는가?** §2.1 의 충돌이 전적으로
   여기 달렸다. 코드를 쓰기 전에 답해야 한다.
2. 다시 쓴다면, 기존 리뷰 코멘트가 다시 걸리도록 PR head sha 도 갱신하는가, 아니면 코멘트가
   미아가 되는가?
3. exit 9 는 정확히 무엇을 기준으로 하는가 — 리포, 조직, 플랜, 롤아웃 코호트?
4. 이미 base 가 올바르게 연결된 PR 들에 `gh stack link` 를 걸면 PR 타임라인에 소음으로 남는
   무의미한 base "교정"이 발생하는가?
5. PR 을 연 계정과 `link` 를 실행하는 계정이 다를 때도 동작하는가? Wooi 는 연결된 사용자로 PR 을
   열므로 아마 무의미한 질문이지만 확인되지 않았다.
6. 스택 생성을 위한 문서화된 정식 REST/GraphQL mutation 이 있어서 발행에서 확장 의존성을 아예
   뗄 수 있는가? 지금 알려진 것은 확장의 비문서화 `POST /repos/{o}/{r}/stacks` 뿐이다.

## 8. 구현 순서

1. **질문 1 에 답한다.** 버리는 리포 하나, `gh stack link` 로 만든 3-PR 스택, 맨 아래를 머지한
   뒤 위 브랜치들을 `git ls-remote` 로 관찰. 반나절. 이게 정리되기 전에는 아무것도 시작하지
   않는다.
2. **읽기 전용, 확장 없이.** `getRepoStacks` / `getStackForPr` 를 담은 `ghStack.ts` 와 2단계
   감지. `StackPopover` 에 스택 번호와 GitHub 순서를 노출. 쓰기 위험 0, 새 의존성 0 으로
   가치(흡수가 더 정확해진다)를 낸다.
3. **§3.3 의 갈라짐 가드** — "원격이 밑에서 움직였다"용 새 `StackCascadeStep` 상태와
   `StackSyncBanner` 노출. 나머지와 무관하게 그 자체로 가치가 있다.
4. **확장 감지와 허용 서브명령 allowlist**, exit 9 영속화.
5. **리포별 옵트인 뒤의 발행**, 기본 꺼짐. PR 생성/retarget 시 `linkStack`, 옵트아웃 시
   `unstackStack`.
6. preview 가 안정되면 **`gh stack merge` 를 별개의 제품 결정으로 다시 검토.**

2·3 단계는 preview 가 어떻게 되든 할 가치가 있다. 4·5 단계는 질문 1 이 깔끔하게 풀리고 웹 UI
스택 맵을 원하는 구체적인 사용자가 있는 게 아니라면, preview 가 preview 를 벗어날 때까지
기다리는 편이 좋다.

## 9. 비교표에 미치는 영향

`docs/alternatives.html` 과 `docs/comparison-sources.json` 은 이 문서에서 **수정하지
않는다** — 별개 변경이다. 이 제안이 나가면 손봐야 할 행이 셋이고, 사실 Wooi 의 도입 여부와
무관하게 GitHub 이 기능을 낸 것만으로 지형이 바뀌었으니 *지금* 손볼 이유가 있다.

- **"Parent merges → children rebased"** — 지금 Wooi 전용으로 주장한다. GitHub 이 stacked PR
  에 대해 서버 측에서 같은 것을 주장한다. 정직한 구분은 Wooi 가 **로컬 worktree** 를 rebase
  한다는 것이고, 그건 GitHub 이 건드릴 수 없다.
- **"Parent merges → child PR bases retargeted"** — 지금 Wooi 전용으로 주장한다. GitHub 이
  stacked PR 에 대해 네이티브로 한다. Wooi 쪽은 GitHub 스택으로 발행된 적 없는 PR 까지 다루고,
  GitHub 이 다루지 않는 닫힌 PR 교착 복구를 포함한다는 점이 남는다.
- **"Adopt a stack created outside the app"** — 이 제안 아래에서는 주장이 오히려 *강해진다*
  (스택 객체를 통해 `gh stack`·jj·Sapling 이 만든 스택도 흡수할 수 있다). 다만 이제 표준이
  존재한다는 사실을 행의 서술이 인정해야 한다.

이 셋은 빼거나 그대로 두기보다, 더 좁고 방어 가능한 주장으로 바꾸는 게 맞다.
