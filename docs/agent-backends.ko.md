# 에이전트 백엔드

[English](./agent-backends.md) · **한국어**

Wooi는 **Claude Code**와 **OpenAI Codex**를 교체 가능한 코딩 에이전트 백엔드로 지원합니다.
Codex 지원은 **Wooi v1.4.0**부터 제공됩니다.

## 에이전트 선택

**Settings → Integrations**에서 하나 이상의 에이전트를 연결합니다. 두 CLI를 모두 사용할 수 있으면
새 워크스페이스 대화상자에서 Claude Code 또는 Codex를 고를 수 있습니다. 선택한 백엔드는
워크스페이스에 저장되며 생성 후 바꿀 수 없습니다. 스택 워크스페이스는 부모의 백엔드를 이어받습니다.

| 백엔드 | 실행 방식 | 로그인 | 최소 버전 |
| --- | --- | --- | --- |
| Claude Code | Claude Agent SDK / 설치된 `claude` CLI | Claude 계정 | 현재 지원 CLI |
| Codex | 설치된 `codex` CLI의 `codex app-server` | ChatGPT 계정 또는 OpenAI API 키 | 0.128.0 |

Codex는 `npm i -g @openai/codex`로 설치합니다. Wooi는 CLI를 번들하지 않으며 로그인 셸의
`PATH`에서 CLI를 찾아 버전을 확인합니다. 설치나 업데이트가 필요하면
**Settings → Integrations**에 안내를 표시합니다.

## 백엔드별 동작

Wooi는 선택한 백엔드가 지원하는 컨트롤만 표시합니다. 따라서 모델, reasoning effort 단계,
권한 모드, 슬래시 명령, 사용량 한도, 계정 정보가 워크스페이스마다 달라질 수 있습니다.

| 기능 | Claude Code | Codex |
| --- | --- | --- |
| 권한 모드 | Default, Accept edits, Plan, Auto | Ask for approval, Approve for me, Full access |
| Reasoning effort | 지원 모델에서 Ultracode를 포함한 백엔드 모델 목록 | Codex가 제공하는 모델별 목록 |
| MCP | 지원 | 지원 |
| 앱 내 로그인 | 지원 | 지원 |
| 계정 사용량 한도 | 지원 | 지원 |
| 턴 실행 중 메시지 전달 | 다음 턴으로 대기 | 지원 |
| 사이드 질문(`/btw`) | 지원 | 미지원 |
| Rewind | 지원 | 미지원 |

Codex는 OS 샌드박스, 승인 정책, 협업 모드의 조합으로 권한을 강제합니다. 특히
**Full access**는 네트워크 제한을 포함한 샌드박스와 승인을 해제하므로, 신뢰하는 저장소와
프롬프트에만 사용하세요.

## 아키텍처

에이전트 독립 코드는 `src/main/agent/backend.ts`의 `AgentBackend` 인터페이스에 의존합니다.
`src/main/agent/registry.ts`는 백엔드 메타데이터, 가용성 검사, 구체 백엔드 생성을 담당합니다.
구현은 다음 디렉터리에 있습니다.

- `src/main/claude/` — Claude Agent SDK 세션과 호스트 프로세스
- `src/main/codex/` — Codex app-server 프로토콜, 이벤트 매핑, 세션, 호스트 프로세스

렌더러는 특정 백엔드를 하드코딩하지 않고 `AgentBackendMeta` capability를 사용합니다.
워크스페이스 레코드는 `agentBackend`를 저장하며, v1.4.0 이전에 만든 기존 워크스페이스는
계속 Claude Code를 사용합니다.
