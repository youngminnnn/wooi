# 스택 레이어 사이에서 커밋 옮기기

[English](./stack-commit-moves.md) · **한국어**

Wooi는 풀 리퀘스트를 `feat/schema` → `feat/api` → `feat/ui`처럼 층으로 쌓는다. 각 PR은 바로
아래층을 base로 삼으므로 리뷰어는 한 덩어리의 변경만 이해하고 병합할 수 있다. 하지만 작업을 나눈
뒤에야 위치가 잘못된 커밋이 보일 때가 있다. `feat/ui`에 들어간 helper가 사실 `feat/api`의
책임인 경우다.

손으로 옮기려면 아래 브랜치에 cherry-pick하고, 위 브랜치에서는 커밋을 빼고, 그보다 위의 모든
레이어를 차례로 restack한 뒤 영향받은 브랜치를 force-push해야 한다. 순서를 틀리면 위 PR이 아래층
변경까지 자기 diff에 다시 끌어안는다. 스택을 만든 이유가 사라진다.

Wooi는 먼저 preview를 보여 주고 이 이동을 한 작업으로 처리한다. 첫 버전의 범위는 **모델 A
스택에서 커밋 하나를 바로 아래 레이어로 한 칸 옮기는 것**이다.

아래에서 **[확인됨]**은 2026-08-22에 하나의 object database를 공유하는 worktree 두 개짜리 임시
저장소에서 실제 Git으로 재현한 사실이다. **[미확인]**은 구현을 읽어 확인했거나 이 작업에 대해서는
아직 직접 실행하지 않은 예상이다.

## 스택 모델이 중요한 이유

Wooi에는 스택 모델이 둘 있다.

**모델 A**는 Wooi 워크스페이스의 체인이다. 레이어마다 자기 Git worktree가 있고,
`parentWorkspaceId`가 바로 아래 워크스페이스를 가리킨다. 자식의 `baseBranch`는 부모의
`branch`다. Wooi가 직접 만드는 스택은 이것뿐이다. `create_stacked_workspace`와 사이드바의 Stack
동작은 모두 `parentWorkspaceId`를 `src/main/workspaces.ts`의 `createWorkspace()`에 넘긴다.
**[미확인]**

**모델 B**는 worktree 하나 안의 여러 브랜치이며 `Workspace.stack`에 저장된다. Wooi는 이 모양을
만들지 않는다. `src/main/stack.ts`의 `buildStackFromPrs()`가 열린 PR의 base 링크에서 감지하고,
`src/main/ipc.ts`의 한 곳에서만 감지한 체인을 `Workspace.stack`에 넣는다. **[미확인]**

첫 버전이 모델 A만 지원하는 까닭은 이것이 Wooi가 실제로 만드는 스택이기 때문이다. 두 레이어의
브랜치는 이미 각자 worktree에 checkout돼 있어 실제 레이어 브랜치를 바꿔 끼울 필요도 없다. 모델 B는
오히려 더 어렵다. worktree 하나의 HEAD를 브랜치 사이로 옮겼다가 원래 자리로 복구해야 한다.

## 로컬 히스토리를 다시 쓰는 방법

이동 전 아래 브랜치 tip을 `L0`, 위 브랜치를 `U`, 옮길 커밋을 `ck`라고 하자. Wooi는 원래 tip을
기록한 뒤 로컬에서 다음 순서로 실행한다.

```text
1) [아래 worktree]  git cherry-pick <ck>                                   -> L1
2) [위 worktree]    git branch   wooi/commit-move-<short-ck> <ck>^
                    git checkout wooi/commit-move-<short-ck>
                    git rebase --onto <L1> <L0> wooi/commit-move-<short-ck> -> MID
3) [위 worktree]    git rebase --onto <MID> <ck> <위 브랜치>
4) [위 worktree]    git branch -D wooi/commit-move-<short-ck>
```

1단계는 `ck`를 아래층에 복사한다. 2단계는 원래 `L0`와 `ck` 사이에 있던 커밋을 새 아래층 tip 위에
재생한다. 3단계는 `ck` 다음 커밋만 재생하므로 다시 만든 위층에는 `ck`가 없다. 3단계가 끝나면 HEAD는
detached 상태가 아니라 위 브랜치로 돌아와 있다. **[확인됨]**

위 브랜치를 한 번 rebase한 뒤 Git의 patch-id 자동 감지에 맡기지 않고 `rebase --onto`를 두 번 쓰는
것은 의도한 선택이다. 두 번째 범위가 `ck` 다음에서 시작하므로 커밋을 구조적으로 제외한다. 아래층
cherry-pick 충돌을 손으로 풀어 새 커밋의 patch-id가 달라져도 결과가 달라지지 않는다.

임시 브랜치는 rebase가 HEAD를 detach하지 않게 하려고 만드는 것이 아니다. 이름 있는 브랜치에서
시작해도 rebase 중 `git rev-parse --abbrev-ref HEAD`는 `HEAD`를 돌려준다. **[확인됨]** 중간에
작업이 끊겼을 때 설명 없는 detached HEAD 대신 `wooi/commit-move-*`라는 눈에 보이는 흔적을 남기는
것이 목적이다. 이 브랜치는 로컬에만 있고 push하지 않는다.

`ck`가 위층의 맨 오래된 커밋, 중간 커밋, 최신 커밋일 때 모두 같은 순서가 동작한다. 양끝에서 생기는
빈 범위 rebase는 성공하는 no-op이다. **[확인됨]** 이동 뒤에는 해당 파일이 아래층의 base 대비 diff에
나타나고 `lower..upper`에서는 사라진다. 레이어 diff가 섞이지 않는다. **[확인됨]**

### 실패와 롤백

원격에 손대기 전 로컬 rewrite는 전부 성공하거나 전부 되돌아간다. 1–3단계가 실패하면 Wooi는 다음과
같은 복구를 실행한다.

```text
git rebase --abort
git checkout <upper>
git branch -D <temp>
git cherry-pick --abort
git reset --hard <L0>
```

실제 구현은 위 브랜치도 기록한 tip으로 reset하고, 두 브랜치의 정확한 tip, 두 worktree의 clean
상태, checkout된 위 브랜치, 임시 브랜치 삭제까지 확인한다. 충돌을 낸 재현에서는 두 브랜치가 원래
SHA로 정확히 돌아왔고, worktree 둘 다 깨끗했으며 임시 브랜치도 없어졌다. **[확인됨]**

순서는 구현 세부가 아니라 정확성의 경계다. 1단계 cherry-pick을 일부러 실패시킨 뒤에도 2–3단계를
계속 돌리자 `ck`가 **두 브랜치에서 모두** 조용히 사라졌다. **[확인됨]** 그래서 Wooi는 새 아래층
tip을 읽어 1단계 성공을 확인한 뒤에만 위층 rewrite를 시작한다.

## 히스토리를 고치기 전에 지키는 안전장치

커밋 하나를 옮겨도 두 레이어의 diff가 바뀌고 그 위의 모든 PR이 움직일 수 있다. 사전 검사는 커밋을
주고받는 worktree 둘만이 아니라 영향받는 체인 전체에 적용한다.

### 가장 먼저 모든 원격 갈라짐을 검사한다

아무것도 바꾸기 전에 `src/main/cascade.ts`의 `detectRemoteDivergence()`로 영향받는 모든 로컬
브랜치를 현재 원격 ref와 비교한다. 로컬이 포함하지 않은 방향으로 원격 하나라도 움직였으면 작업은
시작하지 않는다. **[미확인]**

여기서는 `--force-with-lease`만 믿을 수 없다. `cascade.ts`에는 2026-08-12 재현 결과가 기록돼 있다.
GitHub 스택의 아래 PR이 병합되면 GitHub이 그 위 원격 ref를 서버에서 cascading rebase한다. 로컬
worktree는 예전 tip을 든 채 깨끗하게 남는다. 그 상태에서 `restackOnto()`가 push 직전에 fetch하면
lease 기준도 GitHub의 새 ref로 갱신된다. 결국 force-push가 성공해 GitHub의 rebase를 덮어쓴다.
피해는 충돌을 두 번 푸는 정도가 아니다. 위 레이어가 자기 diff를 잃고 이미 병합한 아래층 변경을 다시
끌어안는다. **[`src/main/cascade.ts`에서 확인됨, 2026-08-12]**

그래서 낡은 `origin/<branch>` 추적 ref나 push 시점의 lease가 아니라 rewrite 전에 원격에 직접 묻는다.

### 영향받는 worktree는 모두 깨끗해야 한다

영향받는 worktree 하나라도 미커밋 변경이 있으면 전체 작업을 막는다. 롤백은 hard reset을 쓰고 위층을
차례로 rebase하므로, 출처를 모르는 dirty 상태까지 보존하며 움직일 수 없다. **[미확인]** 실행 중인
워크스페이스와 모델 B 워크스페이스도 작업을 막는다. **[미확인]**

### rewrite보다 preview가 먼저다

preview는 옮길 커밋, 아래·위 브랜치, 뒤이어 restack하고 force-push할 모든 위쪽 브랜치, 작업 전 tip
SHA를 보여 준다. 위층 diff에서 아래층 diff로 옮겨갈 경로도 보여 준다. **[미확인]**

이 파일 목록은 `ck`가 바꾼 경로이지, 이동 뒤 diff를 미리 다시 계산한 결과가 아니다. 정확한 결과는
Git이 히스토리를 고친 뒤에만 알 수 있다. preview는 현재 확실히 아는 것, 즉 두 레이어 diff 사이에서
소유권이 바뀌는 파일과 rewrite될 브랜치를 보여 준다.

### 작업 전후 tip을 남긴다

Wooi는 시작 전에 영향받는 모든 브랜치 tip을 기록하고 결과에 전후 SHA를 함께 담는다. 사용자가 직접
복구할 때 쓸 닻이다. **[미확인]** 자동 롤백의 경계는 첫 push 성공 전까지다. rewrite한 브랜치가 하나라도
원격에 나간 뒤에는 자동으로 되돌리지 않는다. 원격을 한 번 더 고치면 그사이 들어온 협업자의 작업을
덮을 수 있기 때문이다. 대신 완료된 단계와 기록한 SHA를 보고한다. **[미확인]**

### 충돌은 반쯤 남기지 않고 되돌린다

기존 restack 버튼은 worktree 하나에서 rebase 하나를 실행하므로 충돌 상태를 남겨 사용자가 풀고
계속할 수 있다. 커밋 이동은 worktree 둘과 레이어 브랜치 둘을 건드리고, 로컬의 두 번 rebase 뒤에는
여러 위쪽 브랜치까지 restack할 수 있다. 중간 상태를 남기면 사용자가 worktree마다 있어야 할 히스토리를
역으로 재구성해야 한다.

따라서 첫 push 전 충돌은 반쯤 끝난 rebase를 넘기지 않고 abort와 롤백으로 마친다. **[미확인]** 충돌은
대개 `ck`가 위층에 남는 커밋에 의존한다는 뜻이다. 사용자에게 알려야 할 의존 관계이지 대신 풀라고
넘길 단순 작업이 아니다.

## 나머지 스택 갱신

아래·위 브랜치를 다시 만든 뒤 아래에서 위 순서로 force-push한다. 이어서 가장 가까운 자식부터
descendant를 restack한다. 그래야 각 레이어가 바로 아래에서 이미 갱신된 tip 위에 재생된다.
**[미확인]**

위쪽 레이어에는 `src/main/git.ts`의 `restackOnto()`를 바꾸지 않고 재사용한다. 원격 갈라짐 검사와
`StackCascadeStep` 결과 모양은 `src/main/cascade.ts`에서 가져오고, 진행 상황은 기존 restack과 같은
`StackOpProgress` 채널로 보낸다. **[미확인]**

force-push 뒤 GitHub이 PR diff를 다시 계산하므로 새 레이어 diff는 자동으로 나타날 것으로 예상한다.
`cascade.ts`에는 GitHub 자체 rebase와 외부 force-push 모두에서 리뷰 코멘트가 다시 앵커링된다고
기록돼 있다. 커밋 이동도 rewrite 뒤 force-push하는 작업이므로 같은 동작을 예상하지만, 이 작업에
대해서는 아직 직접 확인하지 않았다. **[미확인]**

## 첫 버전에서 일부러 하지 않는 것

비슷해 보여도 다른 문제는 이번 범위에 섞지 않는다.

- **레이어 쪼개기**는 새 PR을 열고 기존 PR의 base를 다시 연결해야 한다. GitHub 쪽 작업까지 한 번에
  넣으면 단일 변경으로 리뷰하기 어려워진다.
- **`git absorb`식 hunk 흡수**는 각 hunk가 어느 기존 커밋의 책임인지 판단해야 한다. 이미 고른
  커밋을 옮기는 것과 별개의 문제다.
- **모델 B**는 worktree 하나에서 브랜치를 checkout하고 원상복구해야 한다.
- **위로 옮기거나 인접하지 않은 층을 건너뛰는 이동**은 의존성과 실행 순서가 다르다.
- **여러 커밋 동시 이동**에는 선택 순서와 부분 의존성 문제가 생긴다.

커밋 하나, 아래로 한 칸, 모델 A로 좁혀야 히스토리 rewrite를 명시적으로 설명하고, 미리 보여 주고,
복구할 수 있다.
