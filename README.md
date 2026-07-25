# CLA signatures

이 브랜치는 코드가 아니라 **CLA 서명 기록만** 보관한다.
`.github/workflows/cla.yml` 의 contributor-assistant 액션이 PR 에서 서명 코멘트를
확인하면 `signatures.json` 에 서명자를 추가 커밋한다.

- main 은 브랜치 보호(PR 필수)가 걸려 있어 github-actions[bot] 이 직접 커밋할 수
  없으므로 서명 파일을 이 전용 브랜치에 둔다.
- 따라서 이 브랜치에는 **브랜치 보호를 걸지 말 것** — 보호하면 서명 기록이 실패한다.
- 히스토리는 main 과 무관한 orphan 이며, 직접 편집하지 않는다.
