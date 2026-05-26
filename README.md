# Agent Console

로컬에 설치된 Hermes, Pi, ZeroClaw를 한 화면에서 상태 확인하고 단발 채팅으로 실행하는 Bun 기반 도구입니다.
관리 영역에서 세 에이전트를 개별 또는 전체 업데이트할 수 있습니다.

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
기본값은 `AGENT_CONSOLE_PROVIDER=openai-codex`, `AGENT_CONSOLE_MODEL=gpt-5.5`입니다.
일부 Windows 네이티브 도구 출력이 깨지면 `AGENT_CONSOLE_OUTPUT_ENCODING=euc-kr`처럼 출력 디코딩을 바꿀 수 있습니다.

```powershell
$env:AGENT_CONSOLE_PROVIDER = "openai-codex"
$env:AGENT_CONSOLE_MODEL = "gpt-5.5"
$env:AGENT_CONSOLE_OUTPUT_ENCODING = "utf-8"
bun run start
```

```bash
AGENT_CONSOLE_PROVIDER="openai-codex" AGENT_CONSOLE_MODEL="gpt-5.5" bun run start
```

설치되지 않은 에이전트는 상태가 `설치 안 됨`으로 표시되고, 해당 채팅/관리/업데이트 버튼은 자동으로 비활성화됩니다. `전체 업데이트`는 설치된 에이전트만 대상으로 실행됩니다.

## 편의 기능

- 출력 기록과 최근 작업 폴더는 브라우저 `localStorage`에만 저장됩니다. 저장소에 올라가는 파일에는 개인 경로나 실행 로그가 포함되지 않습니다.
- 채팅 입력 옆의 프롬프트 템플릿으로 코드 리뷰, 폴더 요약, 테스트 진단, 오류 분석 요청을 빠르게 채울 수 있습니다.
- 채팅 응답은 실시간 스트리밍으로 출력됩니다. 에이전트나 CLI가 중간 출력을 flush하지 않으면 마지막에 한 번에 보일 수 있습니다.
- 출력 블록은 안전한 일부 마크다운 렌더링과 복사 버튼을 지원합니다. 긴 출력은 위로 스크롤해 읽는 동안 자동 하단 스크롤이 잠시 멈춥니다.
- 메시지는 `Ctrl+Enter`로 보낼 수 있고, `Alt+Up` / `Alt+Down`으로 최근 프롬프트를 다시 불러올 수 있습니다.
- 실행 중에는 같은 영역의 `중단 Esc` 버튼이나 `Esc` 키로 중단할 수 있습니다.
- 긴 작업이 끝났을 때 브라우저 알림 권한이 허용되어 있으면 완료 알림을 보냅니다.

## 구성

- `index.html`: 화면 뼈대
- `public/app.css`: 화면 스타일
- `public/app.js`: 브라우저 UI 로직
- `server.ts`: 서버 엔트리포인트
- `src/server/config.ts`: 경로, 모델, 도구 설정
- `src/server/process.ts`: CLI 실행/스트리밍 공통 로직
- `src/server/agents.ts`: Hermes, Pi, ZeroClaw 상태/채팅/업데이트 로직
- `src/server/http.ts`: HTTP 라우팅과 정적 파일 서빙
- `launch.ps1`: 서버 실행
- `start.cmd`: 더블클릭 실행용
- `stop.cmd`: 실행 중인 서버 종료
- `start.sh`: Linux/macOS 실행용
- `stop.sh`: Linux/macOS 종료용
- `package.json`: Bun 실행 스크립트
