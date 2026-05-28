# Agent Console

로컬에 설치된 Hermes, Pi, ZeroClaw를 한 화면에서 상태 확인하고 단발 채팅으로 실행하는 Bun 기반 도구입니다.
관리 영역에서 업데이트 명령을 제공하는 에이전트를 개별 또는 전체 업데이트할 수 있습니다.

## 실행

공통 실행:

```powershell
cd <agent-console를 클론한 폴더>
bun run start
```

브라우저에서 `http://127.0.0.1:8765`를 엽니다.

Windows에서 더블클릭으로 실행하려면 `start.cmd`를 사용합니다. 이미 서버가 떠 있으면 새로 띄우지 않고 브라우저만 엽니다. 종료하려면 `stop.cmd`를 사용합니다.
기본 작업 폴더는 실행 중인 컴퓨터에서 존재하는 경로를 자동 선택합니다: `~/Documents/workspace`, `~/workspace`, 홈 폴더, 앱 폴더 순서입니다.

Linux/macOS:

```bash
cd ~/workspace/agent-console
chmod +x start.sh stop.sh
./start.sh
```

종료:

```bash
./stop.sh
```

## 실행 파일 탐색

Agent Console은 아래 순서로 Hermes, Pi, ZeroClaw 실행 파일을 찾습니다.

1. 환경 변수: `HERMES_BIN`, `PI_BIN`, `ZEROCLAW_BIN`
2. 운영체제별 흔한 설치 경로
   - Windows: `%USERPROFILE%\.bun\bin`, `%USERPROFILE%\.cargo\bin`, Hermes 로컬 설치 경로
   - Linux/macOS: `~/.bun/bin`, `~/.cargo/bin`, `~/.local/bin`
3. `PATH`에 등록된 `hermes`, `pi`, `zeroclaw` 명령

다른 노트북에서 설치 경로가 다르면 환경 변수로 직접 지정할 수 있습니다.
실행 파일 이름이 `PATH`에 잡혀 있다면 절대 경로 대신 `pi`, `hermes`, `zeroclaw`처럼 명령 이름만 넣어도 됩니다.

```powershell
$env:PI_BIN = "D:\tools\pi.exe"
$env:ZEROCLAW_BIN = "D:\tools\zeroclaw.exe"
bun run start
```

```bash
PI_BIN="$HOME/.bun/bin/pi" ZEROCLAW_BIN="$HOME/.cargo/bin/zeroclaw" bun run start
```

기본 모델/프로바이더도 환경 변수로 바꿀 수 있습니다.
기본값에서는 각 CLI가 자체 설정한 provider/model을 사용합니다. Agent Console에서 강제로 override해야 할 때만 `AGENT_CONSOLE_PROVIDER`, `AGENT_CONSOLE_MODEL`을 지정하세요.
일부 Windows 네이티브 도구 출력이 깨지면 `AGENT_CONSOLE_OUTPUT_ENCODING=euc-kr`처럼 출력 디코딩을 바꿀 수 있습니다.

```powershell
$env:AGENT_CONSOLE_PROVIDER = "openai"
$env:AGENT_CONSOLE_MODEL = "gpt-5.5"
$env:AGENT_CONSOLE_OUTPUT_ENCODING = "utf-8"
bun run start
```

```bash
AGENT_CONSOLE_PROVIDER="openai" AGENT_CONSOLE_MODEL="gpt-5.5" bun run start
```

설치되지 않은 에이전트는 상태가 `설치 안 됨`으로 표시되고, 해당 채팅/관리/업데이트 버튼은 자동으로 비활성화됩니다. `전체 업데이트`는 설치되어 있고 Agent Console에 업데이트 명령이 등록된 에이전트만 대상으로 실행됩니다. ZeroClaw는 자체 `update` 서브커맨드 대신 공식 GitHub 릴리스의 Windows prebuilt asset을 내려받아 `SHA256SUMS`로 검증한 뒤 `~/.zeroclaw/bin/zeroclaw.exe`에 설치합니다.

## 편의 기능

- 출력 기록과 최근 작업 폴더는 브라우저 `localStorage`에만 저장됩니다. 저장소에 올라가는 파일에는 개인 경로나 실행 로그가 포함되지 않습니다.
- 채팅 입력 옆의 프롬프트 템플릿으로 코드 리뷰, 폴더 요약, 테스트 진단, 오류 분석, 잠재 버그/성능 감사, UI/UX 감사, 기능 아이디어 요청을 빠르게 채울 수 있습니다.
- 채팅 응답은 실시간 스트리밍으로 출력됩니다. 에이전트나 CLI가 중간 출력을 flush하지 않으면 마지막에 한 번에 보일 수 있습니다.
- 사이드바의 `최근 실행` 패널에서 진행 중/완료/오류/중단된 실행을 확인하고, 진행 중인 실행은 바로 중단할 수 있습니다. 실행 행을 클릭하면 기록된 명령, 폴더, 소요 시간, 종료 코드 같은 상세 메타데이터를 볼 수 있습니다.
- `stdin 허용`을 켠 실행은 CLI 표준입력 파이프를 열고, `최근 실행` 패널에서 stdin 텍스트를 전송할 수 있습니다. 출력에서 승인/계속 여부를 묻는 패턴이 감지되면 상태가 `대기`로 바뀝니다. 기본값은 꺼짐입니다. 일부 CLI는 stdin이 열린 상태에서 종료를 기다리기 때문에 필요할 때만 켜세요.
- 관리 영역의 `자유 설정 적용`은 새 노트북의 Hermes, Pi, ZeroClaw 설정을 이 PC의 개방형 프로파일에 맞춥니다. 기존 설정 파일은 `.bak.YYYYMMDD_HHMMSS` 백업을 남긴 뒤 수정합니다. 함께 적용되는 편의 설정은 Pi의 조용한 시작/긴 캐시/재시도/컴팩션, Hermes의 메모리/프로젝트 관리 스킬, ZeroClaw의 백업/런타임 추적/루프 감지/응답 캐시, 그리고 `~/.agent-console/agent-env.ps1`/`.sh` 환경 헬퍼입니다. Provider/model은 `AGENT_CONSOLE_PROFILE_PROVIDER`, `AGENT_CONSOLE_PROFILE_MODEL`을 지정했을 때만 덮어씁니다.
- 헤더의 `스냅샷` 버튼은 Codex 같은 외부 자동화가 보는 것과 같은 서버/에이전트/실행 상태 JSON을 보여줍니다.
- 출력 블록은 안전한 일부 마크다운 렌더링, 검색/필터, 복사 버튼을 지원합니다. 긴 출력은 위로 스크롤해 읽는 동안 자동 하단 스크롤이 잠시 멈춥니다.
- 메시지는 `Ctrl+Enter`로 보낼 수 있고, `Alt+Up` / `Alt+Down`으로 최근 프롬프트를 다시 불러올 수 있습니다.
- 실행 중에는 같은 영역의 `중단 Esc` 버튼이나 `Esc` 키로 중단할 수 있습니다.
- 긴 작업이 끝났을 때 브라우저 알림 권한이 허용되어 있으면 완료 알림을 보냅니다.

## Codex용 관측 API

Codex 같은 로컬 자동화 도구가 Agent Console 상태를 구조적으로 읽을 수 있도록 JSON API를 제공합니다.

- `GET /api/snapshot`: 서버 설정, 에이전트 상태, 진행 중 실행, 최근 실행, 진단 이슈를 한 번에 반환합니다.
- `GET /api/events`: 실행 시작/명령 확인/완료/중단 요청을 Server-Sent Events로 실시간 전송합니다.
- `GET /api/ws`: WebSocket으로 동일한 실행 이벤트를 받고, `{"type":"stop","runId":"..."}` 또는 `{"type":"input","runId":"...","text":"y\n"}` 메시지로 실행을 제어합니다.
- `GET /api/runs?limit=30`: 최근 실행 이력을 반환합니다.
- `GET /api/runs/<runId>`: 특정 실행 기록을 반환합니다.
- `POST /api/runs/<runId>/stop`: 진행 중인 실행을 중단합니다.
- `POST /api/runs/<runId>/input`: 진행 중인 실행의 stdin에 텍스트를 씁니다. 기본적으로 개행을 붙이며, `{ "newline": false }`로 끌 수 있습니다.

완료된 실행 이력은 `.agent-console/runs.jsonl`에 JSONL로 저장됩니다. 이 폴더는 로컬 런타임 상태라서 Git에는 포함하지 않습니다.

## 에이전트 추가 구조

Hermes, Pi, ZeroClaw는 [src/server/config.ts](src/server/config.ts)의 `agentDefinitions`에 정의되어 있습니다. 새 CLI 에이전트를 추가할 때는 이 목록에 `id`, 표시 이름, 실행 파일 탐색 정보, 상태/버전 명령, 프리셋을 추가하는 방식으로 확장합니다. 해당 CLI가 실제 업데이트 명령을 제공할 때만 `updateArgs`를 추가하세요.

프론트엔드는 `/api/status`가 내려주는 `agents`와 `presets` 메타데이터를 기준으로 채팅 탭과 관리 버튼을 자동 생성합니다. 새 에이전트가 기존 Hermes/Pi/ZeroClaw와 다른 채팅 CLI 형식을 쓰면 [src/server/agents.ts](src/server/agents.ts)의 `chatCommand()`에 해당 `chatKind` 처리만 추가하면 됩니다.

## 구성

- `index.html`: 화면 뼈대
- `public/app.css`: 화면 스타일 엔트리포인트
- `public/css/`: 화면 스타일 모듈
- `public/app.js`: 브라우저 엔트리포인트
- `public/js/`: 브라우저 UI 모듈
- `server.ts`: 서버 엔트리포인트
- `src/server/config.ts`: 에이전트 정의, 경로, 모델, 도구 설정
- `src/server/process.ts`: CLI 실행/스트리밍 공통 로직
- `src/server/agents.ts`: Hermes, Pi, ZeroClaw 상태/채팅/업데이트 로직
- `src/server/runs.ts`: 실행 이력, 진행 중 실행, snapshot API 상태
- `src/server/http.ts`: HTTP 라우팅과 정적 파일 서빙
- `launch.ps1`: 서버 실행
- `start.cmd`: 더블클릭 실행용
- `stop.cmd`: 실행 중인 서버 종료
- `start.sh`: Linux/macOS 실행용
- `stop.sh`: Linux/macOS 종료용
- `package.json`: Bun 실행 스크립트
