export const storageKeys = {
  output: "agentConsole.outputHistory",
  cwdHistory: "agentConsole.cwdHistory",
  promptHistory: "agentConsole.promptHistory",
};

export const promptTemplates = {
  review: "현재 작업 폴더의 코드를 검토해줘. 버그 가능성, 위험한 변경점, 빠진 테스트를 우선순위대로 짚고 필요한 경우 파일 경로와 함께 말해줘.",
  summarize: "현재 작업 폴더의 구조와 목적을 빠르게 파악해서 핵심 파일, 실행 방법, 주의할 점만 요약해줘.",
  test: "현재 작업 폴더에서 테스트/빌드 상태를 진단해줘. 어떤 명령을 실행해야 하는지 먼저 판단하고, 실패하면 원인과 다음 조치를 정리해줘.",
  fix: "아래 오류 로그를 분석해서 원인, 확인할 파일, 가장 작은 수정 방향, 검증 명령 순서로 정리해줘.\n\n",
  bugAudit: "현재 작업 폴더의 코드베이스를 잠재적 버그, 성능 저하, 리소스 누수, 크로스플랫폼 문제, 보안상 위험한 설계 관점에서 검토해줘. 실제 파일을 읽고 근거를 잡아줘. 결과는 심각도 순서로 정리하고, 각 항목마다 파일/함수 위치, 왜 문제인지, 재현 가능성, 추천 수정 방향을 포함해줘. 추측이면 추측이라고 표시하고, 확실한 문제와 개선 제안을 구분해줘.",
  uxAudit: "현재 작업 폴더의 프론트엔드/UI 코드를 UI/UX 관점에서 검토해줘. 레이아웃, 정보 구조, 접근성, 키보드 사용성, 피드백/로딩 상태, 반응형, 시각적 일관성, 텍스트 가독성, 버튼/입력 컨트롤의 사용성을 기준으로 부족한 부분을 짚어줘. 실제 코드와 화면 구조에 근거해서 우선순위별로 정리하고, 바로 고칠 수 있는 개선안과 장기 개선안을 나눠줘.",
  ideas: "현재 작업 폴더의 코드베이스와 제품 목적을 파악한 뒤, 더 추가하면 좋을 기능 아이디어를 제안해줘. 흔한 기능 나열 말고 이 도구의 실제 사용 맥락에서 생산성을 올릴 만한 아이디어를 우선해줘. 각 아이디어마다 사용자 가치, 구현 난이도, 건드릴 파일/모듈, 예상 리스크를 포함하고, 마지막에 추천 구현 순서를 제안해줘.",
};

export const state = {
  activeAgent: "pi",
  agents: [],
  presets: [],
  cwdTouched: false,
  activeRequest: null,
  cwdValidateController: null,
  cwdValidatePromise: null,
  installedTools: {},
  runTimer: null,
  abortedControllers: new WeakSet(),
  outputHistory: [],
  promptHistoryIndex: -1,
  promptHistoryDraft: "",
  outputPinned: true,
  eventsSocket: null,
  eventsController: null,
};

export const maxOutputBlocks = 80;
export const maxStoredBlockChars = 12000;
