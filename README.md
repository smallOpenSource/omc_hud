# 커스텀 OMC HUD 설치 스크립트

Claude Code + oh-my-claudecode(OMC)용 컴팩트·컬러 상태표시줄(statusline)을 설치합니다.

```
OMC#4.14.6|Op4.8(max)|5h:2%/3h58m|wk:23%/3d3h|sn:1%/3d3h|think|ctx:0%|se:0.0hr|🔧48|🤖1|C:/경로|계정
```

- 공백 없는 `|` 구분자, 대괄호 없음, 컴팩트 모델 표기 + `(max)` 등급
- 사용량 창은 `퍼센트/리셋시간`, 임계값 색상(녹색 <70, 노랑 <85, 빨강 ≥85)
- 리셋 시간은 시안, 컨텍스트는 임계값 색상, `se:`는 세션 경과(시간 단위)
- 이모지 콜카운트(`🔧 툴`, `🤖 에이전트`, `⚡ 스킬`) — **누적 호출 수**, 파이프로 구분
- 현재 작업 경로(시안)와 로그인 계정의 `@` 앞부분(밝은 초록)

## 사전 요구사항

- **Node.js** 가 PATH에 있어야 함
- **OMC 설치** 필요 (`/plugin install oh-my-claudecode` 또는 `npm i -g oh-my-claude-sisyphus`)

## 설치 방법

| OS | 명령어 |
|----|--------|
| Linux | `bash apply-hud-linux.sh` |
| macOS | `bash apply-hud-macos.sh` |
| Windows | `powershell -ExecutionPolicy Bypass -File .\apply-hud-windows.ps1` |

또는 어느 OS에서든 직접 실행: `node apply-hud.mjs`

설치 후 **Claude Code를 재시작**하세요.

## 설치되는 항목

모든 런처는 `apply-hud.mjs`를 호출하며, `${CLAUDE_CONFIG_DIR:-~/.claude}` 아래에 다음을 기록합니다.

| 경로 | 용도 |
|------|------|
| `hud/omc-hud.mjs` | OMC HUD 로더 (설치된 플러그인에서 복사) |
| `hud/lib/config-dir.mjs` | 로더 의존 파일 |
| `hud/omc-hud-custom.mjs` | 커스텀 포맷터 (OMC 출력을 받아 재구성) |
| `.omc/hud-config.json` | HUD 프리셋/요소 (막대 없음, 이모지 카운트, 절대 경로) |
| `settings.json` | `statusLine` → 커스텀 포맷터 (기존 파일은 백업) |

`CLAUDE_CONFIG_DIR` 환경변수를 존중합니다. `statusLine` 키를 설정하기 전,
기존 `settings.json`은 `settings.json.backup.<타임스탬프>`로 백업합니다.

## 동작 원리

`omc-hud-custom.mjs`는 정식 OMC HUD를 실행한 뒤 ANSI를 제거하고, 위의 컴팩트 형식으로
자체 색상을 입혀 라인을 재구성합니다. OMC의 출력 형식(구분자, 대괄호, `Model:` 접두어,
`퍼센트(시간)` 레이아웃, `session:Nm`)은 소스에 하드코딩되어 있어, 래퍼에서 후처리하는 것이
플러그인을 건드리지 않는 유일한 방법입니다. 파싱에 실패하면 OMC 원본 출력을 그대로
출력하므로, OMC 업데이트 이후에도 상태표시줄이 깨지지 않습니다.

## 커스터마이즈

- 색상/레이아웃: `hud/omc-hud-custom.mjs` 수정 (상단의 색상 헬퍼)
- HUD 요소/프리셋: `.omc/hud-config.json` 수정 (매 렌더마다 즉시 반영)
- `(max)` 등급은 포맷터의 `PLAN_TIER` 상수 — 다른 플랜이면 이 값만 변경
