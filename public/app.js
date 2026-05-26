const statusList = document.getElementById('statusList');
    const agentCards = document.getElementById('agentCards');
    const output = document.getElementById('output');
    const cwd = document.getElementById('cwd');
    const cwdHistory = document.getElementById('cwdHistory');
    const cwdStatus = document.getElementById('cwdStatus');
    const promptBox = document.getElementById('prompt');
    const promptError = document.getElementById('promptError');
    const sendBtn = document.getElementById('sendBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const clearBtn = document.getElementById('clearBtn');
    const stopBtn = document.getElementById('stopBtn');
    const inlineStopBtn = document.getElementById('inlineStopBtn');
    const runStatus = document.getElementById('runStatus');
    const activeRunBanner = document.getElementById('activeRunBanner');
    const managePanel = document.getElementById('managePanel');
    const thinkingField = document.getElementById('thinkingField');
    const thinkingLabel = document.getElementById('thinkingLabel');
    const template = document.getElementById('template');
    const speed = document.getElementById('speed');
    const thinking = document.getElementById('thinking');
    const timeout = document.getElementById('timeout');
    let activeAgent = 'pi';
    let cwdTouched = false;
    let activeRequest = null;
    let cwdValidateController = null;
    let cwdValidatePromise = null;
    let installedTools = {};
    let runTimer = null;
    const abortedControllers = new WeakSet();
    const maxOutputBlocks = 80;
    const maxStoredBlockChars = 12000;
    let outputPinned = true;
    const storageKeys = {
      output: 'agentConsole.outputHistory',
      cwdHistory: 'agentConsole.cwdHistory',
      promptHistory: 'agentConsole.promptHistory',
    };
    const promptTemplates = {
      review: '현재 작업 폴더의 코드를 검토해줘. 버그 가능성, 위험한 변경점, 빠진 테스트를 우선순위대로 짚고 필요한 경우 파일 경로와 함께 말해줘.',
      summarize: '현재 작업 폴더의 구조와 목적을 빠르게 파악해서 핵심 파일, 실행 방법, 주의할 점만 요약해줘.',
      test: '현재 작업 폴더에서 테스트/빌드 상태를 진단해줘. 어떤 명령을 실행해야 하는지 먼저 판단하고, 실패하면 원인과 다음 조치를 정리해줘.',
      fix: '아래 오류 로그를 분석해서 원인, 확인할 파일, 가장 작은 수정 방향, 검증 명령 순서로 정리해줘.\n\n',
    };
    let outputHistory = [];
    let promptHistoryIndex = -1;

    function setButtonBusy(button, busy) {
      if (!button) return;
      if (busy) {
        button.dataset.originalHtml = button.dataset.originalHtml || button.innerHTML;
        button.classList.add('busy');
        button.innerHTML = '<span class="spinner"></span><span>처리 중...</span>';
      } else if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        button.classList.remove('busy');
      }
      button.disabled = busy;
    }

    function setRequestRunning(controller, button, label = '작업') {
      activeRequest = controller ? { controller, button, label } : null;
      stopBtn.disabled = !controller;
      inlineStopBtn.disabled = !controller;
      inlineStopBtn.classList.toggle('active', Boolean(controller));
      if (runTimer) {
        clearInterval(runTimer);
        runTimer = null;
      }
      if (!controller) {
        runStatus.textContent = '대기';
        activeRunBanner.hidden = true;
        activeRunBanner.replaceChildren();
        return;
      }
      const startedAt = Date.now();
      const updateRunStatus = () => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        runStatus.textContent = `${seconds}s`;
        renderRunBanner(label, seconds);
      };
      runStatus.innerHTML = '<span class="spinner"></span>';
      renderRunBanner(label, 0);
      runTimer = setInterval(() => {
        updateRunStatus();
      }, 1000);
    }

    function renderRunBanner(label, seconds) {
      const spin = document.createElement('span');
      spin.className = 'spinner';
      const title = document.createElement('strong');
      title.textContent = label;
      const time = document.createElement('span');
      time.textContent = `${seconds}s 경과`;
      activeRunBanner.replaceChildren(spin, title, time);
      activeRunBanner.hidden = false;
    }

    function abortActiveRequest() {
      if (!activeRequest) return false;
      activeRequest.abortedByUser = true;
      abortedControllers.add(activeRequest.controller);
      activeRequest.controller.abort();
      appendBlock('요청 중단을 보냈습니다.', 'warning');
      setButtonBusy(activeRequest.button, false);
      setRequestRunning(null, null);
      return true;
    }

    function append(text, type = 'info') {
      appendBlock(text, type);
    }

    function appendBlock(text, type = 'info', label = typeLabel(type), persist = type !== 'running') {
      const cleanText = stripAnsi(String(text || ''));
      const entry = {
        type,
        label,
        stamp: new Date().toLocaleTimeString(),
        text: cleanText,
      };
      const block = renderOutputBlock(entry);
      if (persist) {
        outputHistory.push({ ...entry, text: truncateStoredText(cleanText) });
        outputHistory = outputHistory.slice(-maxOutputBlocks);
        persistOutputHistory();
      }
      return block;
    }

    function renderOutputBlock(entry) {
      const block = document.createElement('article');
      block.className = `output-block ${entry.type || 'info'}`;

      const head = document.createElement('div');
      head.className = 'output-head';
      const left = document.createElement('span');
      left.textContent = entry.label || typeLabel(entry.type || 'info');
      const right = document.createElement('span');
      right.className = 'output-actions';
      const stamp = document.createElement('span');
      stamp.textContent = entry.stamp || new Date().toLocaleTimeString();
      const copy = document.createElement('button');
      copy.className = 'copy-output';
      copy.type = 'button';
      copy.textContent = '복사';
      copy.addEventListener('click', () => copyOutputText(entry.text || '', copy));
      right.append(stamp, copy);
      head.append(left, right);

      const body = document.createElement('div');
      body.className = 'output-body';
      renderOutputText(body, String(entry.text || ''));

      block.append(head, body);
      output.appendChild(block);
      while (output.children.length > maxOutputBlocks) {
        output.removeChild(output.firstElementChild);
      }
      requestAnimationFrame(() => {
        if (outputPinned) output.scrollTop = output.scrollHeight;
      });
      return block;
    }

    async function copyOutputText(text, button) {
      try {
        await navigator.clipboard.writeText(text);
        const previous = button.textContent;
        button.textContent = '복사됨';
        setTimeout(() => { button.textContent = previous; }, 1200);
      } catch {
        appendBlock('클립보드 복사에 실패했습니다.', 'warning');
      }
    }

    function renderOutputText(node, text) {
      node.textContent = '';
      if (looksLikeMarkdown(text)) {
        node.classList.add('rendered');
        node.innerHTML = renderMarkdown(text);
      } else {
        node.classList.remove('rendered');
        node.textContent = text;
      }
    }

    function restoreOutputHistory() {
      outputHistory = readJsonStorage(storageKeys.output, [])
        .filter(entry => entry && typeof entry.text === 'string')
        .slice(-maxOutputBlocks);
      output.replaceChildren();
      outputHistory.forEach(renderOutputBlock);
    }

    function clearOutput() {
      outputHistory = [];
      try { localStorage.removeItem(storageKeys.output); } catch {}
      output.replaceChildren();
    }

    function readJsonStorage(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
      } catch {
        return fallback;
      }
    }

    function writeJsonStorage(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    }

    function persistOutputHistory() {
      let next = outputHistory.slice(-maxOutputBlocks);
      while (next.length) {
        try {
          localStorage.setItem(storageKeys.output, JSON.stringify(next));
          outputHistory = next;
          return;
        } catch {
          next = next.slice(Math.ceil(next.length / 2));
        }
      }
    }

    function truncateStoredText(text) {
      if (text.length <= maxStoredBlockChars) return text;
      return `${text.slice(0, maxStoredBlockChars)}\n\n[브라우저 저장 기록은 ${maxStoredBlockChars}자까지만 보존됩니다.]`;
    }

    function renderCwdHistory() {
      const entries = readJsonStorage(storageKeys.cwdHistory, []).filter(Boolean).slice(0, 10);
      cwdHistory.replaceChildren();
      for (const entry of entries) {
        const option = document.createElement('option');
        option.value = entry;
        cwdHistory.appendChild(option);
      }
    }

    function rememberCwd(value) {
      const normalized = String(value || '').trim();
      if (!normalized) return;
      const next = readJsonStorage(storageKeys.cwdHistory, [])
        .filter(entry => entry && entry !== normalized);
      next.unshift(normalized);
      writeJsonStorage(storageKeys.cwdHistory, next.slice(0, 10));
      renderCwdHistory();
    }

    function rememberPrompt(value) {
      const normalized = String(value || '').trim();
      if (!normalized) return;
      const next = readJsonStorage(storageKeys.promptHistory, [])
        .filter(entry => entry && entry !== normalized);
      next.unshift(normalized);
      writeJsonStorage(storageKeys.promptHistory, next.slice(0, 50));
      promptHistoryIndex = -1;
    }

    function recallPrompt(direction) {
      const history = readJsonStorage(storageKeys.promptHistory, []).filter(Boolean);
      if (!history.length) return false;
      promptHistoryIndex = Math.max(0, Math.min(history.length - 1, promptHistoryIndex + direction));
      promptBox.value = history[promptHistoryIndex] || '';
      template.value = '';
      autoGrowPrompt();
      return true;
    }

    function typeLabel(type) {
      if (type === 'ok') return '완료';
      if (type === 'error') return '오류';
      if (type === 'warning') return '알림';
      if (type === 'running') return '실행 중';
      return '출력';
    }

    function stripAnsi(value) {
      return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    }

    function renderStatus(data) {
      if (!cwdTouched && data.cwd) {
        cwd.value = data.cwd;
      }
      const tools = data.tools || {};
      installedTools = Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, Boolean(tool.installed)]));
      statusList.innerHTML = Object.entries(tools).map(([name, tool]) => `
        <div class="status-summary-row">
          <span class="status ${tool.ok ? 'ok' : ''}" title="${tool.ok ? '정상' : '확인 필요'}"><span class="sr-only">${tool.ok ? '정상' : '확인 필요'}</span></span>
          <strong>${escapeHtml(name)}</strong>
          <span class="muted">${tool.installed ? (tool.ok ? '정상' : '확인') : '미설치'}</span>
        </div>
      `).join('');

      agentCards.innerHTML = Object.entries(tools).map(([name, tool]) => `
        <article class="panel agent" role="group" aria-label="${escapeHtml(name)} 상태">
          <div class="row"><span class="status ${tool.ok ? 'ok' : ''}" title="${tool.ok ? '정상' : '확인 필요'}"><span class="sr-only">${tool.ok ? '정상' : '확인 필요'}</span></span><h2>${escapeHtml(name)}</h2></div>
          <div class="muted">${escapeHtml(tool.installed ? (tool.summary || '') : '설치 안 됨')}</div>
          <div class="muted">${escapeHtml(tool.path || '')}${tool.source ? ` (${escapeHtml(tool.source)})` : ''}</div>
          ${tool.models ? `<div class="muted">${escapeHtml(tool.models)}</div>` : ''}
          ${tool.message ? `<div class="muted">${escapeHtml(tool.message)}</div>` : ''}
        </article>
      `).join('');
      updateInstallState();
    }

    function updateAgentUi() {
      const isPi = activeAgent === 'pi';
      const usesCustomThinking = isPi && speed.value === 'deep';
      thinkingField.hidden = !usesCustomThinking;
      thinkingLabel.textContent = usesCustomThinking ? 'Pi 생각 수준' : '';
      promptBox.placeholder = `${agentName(activeAgent)}에게 보낼 요청을 입력`;
      document.querySelectorAll('.agentChoice').forEach(button => {
        const selected = button.dataset.agent === activeAgent;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
        button.tabIndex = selected ? 0 : -1;
      });
      sendBtn.disabled = installedTools[activeAgent] === false;
    }

    function updateInstallState() {
      const installedCount = Object.values(installedTools).filter(Boolean).length;
      document.querySelectorAll('[data-update]').forEach(button => {
        const target = button.dataset.update;
        const enabled = target === 'all' ? installedCount > 0 : installedTools[target] !== false;
        button.disabled = !enabled;
        button.title = enabled ? '' : '설치된 실행 파일을 찾지 못했습니다.';
      });
      document.querySelectorAll('[data-preset]').forEach(button => {
        const target = presetAgent(button.dataset.preset);
        const enabled = !target || installedTools[target] !== false;
        button.disabled = !enabled;
        button.title = enabled ? '' : '설치된 실행 파일을 찾지 못했습니다.';
      });
      document.querySelectorAll('.agentChoice').forEach(button => {
        const enabled = installedTools[button.dataset.agent] !== false;
        button.disabled = !enabled;
        button.title = enabled ? '' : '설치된 실행 파일을 찾지 못했습니다.';
      });
      if (installedTools[activeAgent] === false) {
        const next = ['pi', 'hermes', 'zeroclaw'].find((agent) => installedTools[agent] !== false);
        if (next) selectAgent(next);
      }
      sendBtn.disabled = installedTools[activeAgent] === false;
    }

    function presetAgent(key) {
      if (key?.startsWith('hermes_')) return 'hermes';
      if (key?.startsWith('pi_')) return 'pi';
      if (key?.startsWith('zeroclaw_')) return 'zeroclaw';
      return '';
    }

    async function refresh() {
      setButtonBusy(refreshBtn, true);
      try {
        const res = await fetch('/api/status');
        renderStatus(await parseJsonResponse(res));
      } catch (error) {
        append(`상태 조회 실패\n${error}`);
      } finally {
        setButtonBusy(refreshBtn, false);
      }
    }

    async function postJson(path, payload, button) {
      if (path === '/api/chat') {
        const validCwd = await ensureValidCwdBeforeSend();
        if (!validCwd) return;
        payload.cwd = validCwd;
        return postStreamJson('/api/chat-stream', payload, button);
      }
      if (activeRequest) {
        appendBlock('다른 요청이 실행 중입니다. Esc 또는 중단 버튼으로 먼저 멈출 수 있습니다.', 'warning');
        return;
      }
      const controller = new AbortController();
      const startedAt = Date.now();
      if (payload.cwd) rememberCwd(payload.cwd);
      requestNotificationPermission();
      setRequestRunning(controller, button, requestLabel(path, payload));
      setButtonBusy(button, true);
      appendBlock(`${payload.agent ? agentName(payload.agent) : '관리 작업'} 요청을 보냈습니다.`, 'running', undefined, false);
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const data = await parseJsonResponse(res);
        const body = [
          data.command ? `명령: ${data.command}` : '',
          data.cwd ? `폴더: ${data.cwd}` : '',
          data.stdout || '',
          data.stderr ? `${data.ok ? '보조 출력' : '오류'}:\n${data.stderr}` : '',
          data.code !== undefined && data.code !== null ? `종료 코드: ${data.code}` : '',
        ].filter(Boolean).join('\n\n');
        appendBlock(body || JSON.stringify(data, null, 2), data.ok ? 'ok' : 'error');
        notifyCompletion(data.ok ? 'Agent Console 완료' : 'Agent Console 오류', `${payload.agent ? agentName(payload.agent) : '관리 작업'} 실행이 끝났습니다.`, startedAt);
      } catch (error) {
        const abortedByUser = abortedControllers.has(controller);
        if (!(controller.signal.aborted && abortedByUser)) {
          appendBlock(controller.signal.aborted ? '요청이 중단되었습니다.' : `요청 실패\n${error}`, controller.signal.aborted ? 'warning' : 'error');
        }
        notifyCompletion('Agent Console 중단', controller.signal.aborted ? '요청이 중단되었습니다.' : '요청이 실패했습니다.', startedAt);
      } finally {
        setButtonBusy(button, false);
        if (activeRequest?.controller === controller) {
          setRequestRunning(null, null);
        }
      }
    }

    async function postStreamJson(path, payload, button) {
      if (activeRequest) {
        appendBlock('다른 요청이 실행 중입니다. Esc 또는 중단 버튼으로 먼저 멈출 수 있습니다.', 'warning');
        return;
      }
      const controller = new AbortController();
      const startedAt = Date.now();
      let command = '';
      let cwdValue = payload.cwd || '';
      let stdout = '';
      let stderr = '';
      let finalData = null;
      if (payload.cwd) rememberCwd(payload.cwd);
      if (payload.prompt) rememberPrompt(payload.prompt);
      requestNotificationPermission();
      setRequestRunning(controller, button, requestLabel('/api/chat', payload));
      setButtonBusy(button, true);
      const block = appendBlock('', 'running', '실시간 출력', false);
      const bodyNode = block.querySelector('.output-body');
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(await responseErrorMessage(res));
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) handleStreamEvent(JSON.parse(line));
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) handleStreamEvent(JSON.parse(buffer));
        const resultText = formatStreamResult(finalData, command, cwdValue, stdout, stderr);
        block.className = `output-block ${finalData?.ok ? 'ok' : 'error'}`;
        renderOutputText(bodyNode, resultText);
        appendBlock(resultText, finalData?.ok ? 'ok' : 'error', finalData?.ok ? '완료' : '오류', true);
        block.remove();
        notifyCompletion(finalData?.ok ? 'Agent Console 완료' : 'Agent Console 오류', `${agentName(payload.agent)} 실행이 끝났습니다.`, startedAt);
      } catch (error) {
        const abortedByUser = abortedControllers.has(controller);
        if (!(controller.signal.aborted && abortedByUser)) {
          block.className = 'output-block error';
          const errorText = controller.signal.aborted ? '요청이 중단되었습니다.' : `요청 실패\n${error}`;
          renderOutputText(bodyNode, errorText);
          appendBlock(errorText, controller.signal.aborted ? 'warning' : 'error');
        } else {
          const partialText = formatStreamResult({ code: null, ok: false }, command, cwdValue, stdout, `${stderr}${stderr ? '\n' : ''}[사용자에 의해 중단됨]`);
          block.className = 'output-block warning';
          const stoppedText = partialText || '[사용자에 의해 중단됨]';
          renderOutputText(bodyNode, stoppedText);
          outputHistory.push({
            type: 'warning',
            label: '중단됨',
            stamp: new Date().toLocaleTimeString(),
            text: truncateStoredText(stoppedText),
          });
          outputHistory = outputHistory.slice(-maxOutputBlocks);
          persistOutputHistory();
        }
        notifyCompletion('Agent Console 중단', controller.signal.aborted ? '요청이 중단되었습니다.' : '요청이 실패했습니다.', startedAt);
      } finally {
        setButtonBusy(button, false);
        if (activeRequest?.controller === controller) {
          setRequestRunning(null, null);
        }
      }

      function handleStreamEvent(event) {
        if (event.type === 'start') {
          command = event.command || command;
          cwdValue = event.cwd || cwdValue;
        } else if (event.type === 'stdout') {
          stdout += event.text || '';
        } else if (event.type === 'stderr') {
          stderr += event.text || '';
        } else if (event.type === 'done') {
          finalData = event;
          if (event.stderr) stderr += event.stderr;
        }
        bodyNode.textContent = [stdout, stderr ? `\n오류:\n${stderr}` : ''].filter(Boolean).join('');
        if (outputPinned) output.scrollTop = output.scrollHeight;
      }
    }

    function formatStreamResult(data, command, cwdValue, stdout, stderr) {
      return [
        command ? `명령: ${command}` : '',
        cwdValue ? `폴더: ${cwdValue}` : '',
        stdout || '',
        stderr ? `${data?.ok ? '보조 출력' : '오류'}:\n${stderr}` : '',
        data?.code !== undefined && data?.code !== null ? `종료 코드: ${data.code}` : '',
      ].filter(Boolean).join('\n\n');
    }

    async function responseErrorMessage(res) {
      try {
        const data = await res.json();
        return data?.stderr || data?.message || `HTTP ${res.status}`;
      } catch {
        return `HTTP ${res.status}`;
      }
    }

    function selectAgent(agent, focus = false) {
      activeAgent = agent;
      updateAgentUi();
      if (focus) {
        document.querySelector(`.agentChoice[data-agent="${agent}"]`)?.focus();
      }
    }

    function moveFocusWithin(container, columns, delta) {
      const controls = Array.from(container.querySelectorAll('summary, button:not([hidden]):not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), .output-list[tabindex="0"]'))
        .filter(item => item.offsetParent !== null || item === output);
      const current = document.activeElement;
      const index = controls.indexOf(current);
      if (index === -1) {
        controls[0]?.focus();
        return;
      }
      const next = Math.max(0, Math.min(controls.length - 1, index + delta));
      controls[next]?.focus();
    }

    async function validateCwd() {
      const value = cwd.value.trim();
      if (!value) return;
      cwdValidateController?.abort();
      const controller = new AbortController();
      cwdValidateController = controller;
      const validationPromise = (async () => {
        const res = await fetch('/api/validate-cwd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: value }),
          signal: controller.signal,
        });
        const data = await parseJsonResponse(res);
        if (controller.signal.aborted || cwd.value.trim() !== value) return;
        cwd.classList.toggle('invalid', !data.ok);
        cwdStatus.textContent = data.ok ? '' : (data.stderr || '작업 폴더를 확인하세요.');
        if (data.ok) {
          rememberCwd(data.cwd || value);
        }
        return data.ok ? (data.cwd || value) : '';
      })();
      cwdValidatePromise = validationPromise;
      try {
        return await validationPromise;
      } catch (error) {
        if (controller.signal.aborted) return;
        cwd.classList.add('invalid');
        cwdStatus.textContent = error instanceof Error ? error.message : String(error);
        return '';
      } finally {
        if (cwdValidateController === controller) {
          cwdValidateController = null;
        }
        if (cwdValidatePromise === validationPromise) {
          cwdValidatePromise = null;
        }
      }
    }

    async function ensureValidCwdBeforeSend() {
      if (cwdValidatePromise) {
        const pending = await cwdValidatePromise;
        if (pending) return pending;
      }
      const value = cwd.value.trim();
      if (!value) return value;
      return await validateCwd();
    }

    async function parseJsonResponse(res) {
      let data = null;
      try {
        data = await res.json();
      } catch {
      }
      if (!res.ok) {
        throw new Error(data?.stderr || data?.message || `HTTP ${res.status}`);
      }
      return data || {};
    }

    function requestNotificationPermission() {
      if (!('Notification' in window) || Notification.permission !== 'default') return;
      Notification.requestPermission().catch(() => {});
    }

    function notifyCompletion(title, message, startedAt) {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const elapsed = Date.now() - startedAt;
      if (!document.hidden && elapsed < 8000) return;
      new Notification(title, {
        body: message,
        tag: 'agent-console',
        silent: false,
      });
    }

    document.querySelectorAll('.agentChoice').forEach(button => {
      button.addEventListener('click', () => {
        selectAgent(button.dataset.agent);
      });
      button.addEventListener('keydown', event => {
        const choices = Array.from(document.querySelectorAll('.agentChoice'));
        const index = choices.indexOf(button);
        let next = index;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % choices.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + choices.length) % choices.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = choices.length - 1;
        if (next !== index) {
          event.preventDefault();
          selectAgent(choices[next].dataset.agent, true);
        }
      });
    });

    cwd.addEventListener('input', () => {
      cwdTouched = true;
      cwd.classList.remove('invalid');
      cwdStatus.textContent = '';
    });
    cwd.addEventListener('blur', validateCwd);
    template.addEventListener('change', () => {
      const value = promptTemplates[template.value];
      if (!value) return;
      if (promptBox.value.trim() && promptBox.value !== value && !confirm('현재 메시지를 템플릿으로 바꿀까요?')) {
        template.value = '';
        return;
      }
      promptBox.value = value;
      promptBox.classList.remove('invalid');
      promptBox.setAttribute('aria-invalid', 'false');
      promptError.textContent = '';
      autoGrowPrompt();
      promptBox.focus();
    });
    speed.addEventListener('change', updateAgentUi);

    document.querySelectorAll('[data-preset]').forEach(button => {
      button.addEventListener('click', () => {
        postJson('/api/preset', { key: button.dataset.preset, cwd: cwd.value }, button);
      });
    });

    document.querySelectorAll('[data-update]').forEach(button => {
      button.addEventListener('click', () => {
        postJson('/api/update', { target: button.dataset.update, cwd: cwd.value }, button);
      });
    });

    sendBtn.addEventListener('click', () => {
      const prompt = promptBox.value.trim();
      if (!prompt) {
      promptBox.classList.add('invalid');
        promptBox.setAttribute('aria-invalid', 'true');
        promptError.textContent = '메시지를 입력하세요.';
        promptBox.focus();
        return;
      }
      if (installedTools[activeAgent] === false) {
        appendBlock(`${agentName(activeAgent)} 실행 파일을 찾지 못했습니다. 설치하거나 환경 변수를 지정하세요.`, 'warning');
        return;
      }
      promptBox.classList.remove('invalid');
      promptBox.setAttribute('aria-invalid', 'false');
      promptError.textContent = '';
      postJson('/api/chat', {
        agent: activeAgent,
        prompt,
        cwd: cwd.value,
        speed: speed.value,
        thinking: thinking.value,
        timeout: Number(timeout.value || 600),
      }, sendBtn);
    });

    promptBox.addEventListener('keydown', event => {
      if (event.ctrlKey && event.key === 'Enter') {
        sendBtn.click();
      }
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        recallPrompt(event.key === 'ArrowUp' ? 1 : -1);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        promptBox.blur();
      }
    });
    promptBox.addEventListener('input', () => {
      autoGrowPrompt();
      if (promptBox.value.trim()) {
        promptBox.classList.remove('invalid');
        promptBox.setAttribute('aria-invalid', 'false');
        promptError.textContent = '';
      }
      if (template.value && promptBox.value !== promptTemplates[template.value]) {
        template.value = '';
      }
    });

    refreshBtn.addEventListener('click', refresh);
    clearBtn.addEventListener('click', clearOutput);
    output.addEventListener('scroll', () => {
      outputPinned = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
    });
    stopBtn.addEventListener('click', abortActiveRequest);
    inlineStopBtn.addEventListener('click', abortActiveRequest);
    managePanel.addEventListener('keydown', event => {
      if (event.target?.tagName === 'SUMMARY') return;
      const columns = window.matchMedia('(max-width: 900px)').matches ? 1 : 2;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveFocusWithin(managePanel, columns, 1);
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveFocusWithin(managePanel, columns, -1);
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveFocusWithin(managePanel, columns, columns);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocusWithin(managePanel, columns, -columns);
      }
      if (event.key === 'Home') {
        event.preventDefault();
        managePanel.querySelector('button')?.focus();
      }
      if (event.key === 'End') {
        event.preventDefault();
        Array.from(managePanel.querySelectorAll('button')).at(-1)?.focus();
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && abortActiveRequest()) {
        event.preventDefault();
      }
    });

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function agentName(agent) {
      if (agent === 'hermes') return 'Hermes';
      if (agent === 'zeroclaw') return 'ZeroClaw';
      return 'Pi';
    }

    function speedName(value) {
      if (value === 'balanced') return '균형';
      if (value === 'deep') return '깊게';
      return '빠름';
    }

    function requestLabel(path, payload) {
      if (path === '/api/chat') return `${agentName(payload.agent)} · ${speedName(payload.speed)}`;
      if (path === '/api/update') return payload.target === 'all' ? '전체 업데이트' : `${agentName(payload.target)} 업데이트`;
      if (path === '/api/preset') return '관리 작업';
      return '작업';
    }

    function autoGrowPrompt() {
      promptBox.style.height = 'auto';
      promptBox.style.height = `${Math.min(Math.max(promptBox.scrollHeight, 170), 360)}px`;
    }

    function looksLikeMarkdown(text) {
      return /(^|\n)(#{1,4}\s|[-*]\s|\d+\.\s|```)|`[^`]+`|\*\*[^*]+\*\*/.test(text);
    }

    function renderMarkdown(text) {
      const blocks = [];
      let index = 0;
      const escaped = escapeHtml(text).replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
        const token = `@@CODE_${blocks.length}@@`;
        blocks.push(`<pre><code${lang ? ` data-lang="${lang}"` : ''}>${code}</code></pre>`);
        return token;
      });
      const lines = escaped.split(/\r?\n/);
      const html = [];
      while (index < lines.length) {
        const line = lines[index];
        const heading = /^(#{1,4})\s+(.+)$/.exec(line);
        if (heading) {
          const level = Math.min(4, heading[1].length + 2);
          html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
          index += 1;
          continue;
        }
        if (/^[-*]\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
            items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^[-*]\s+/, ''))}</li>`);
            index += 1;
          }
          html.push(`<ul>${items.join('')}</ul>`);
          continue;
        }
        if (/^\d+\.\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
            items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^\d+\.\s+/, ''))}</li>`);
            index += 1;
          }
          html.push(`<ol>${items.join('')}</ol>`);
          continue;
        }
        if (!line.trim()) {
          index += 1;
          continue;
        }
        const paragraph = [];
        while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+|^[-*]\s+|^\d+\.\s+/.test(lines[index])) {
          const codeToken = /^@@CODE_(\d+)@@$/.exec(lines[index]);
          if (codeToken) {
            if (paragraph.length) {
              html.push(`<p>${renderInlineMarkdown(paragraph.join('<br>'))}</p>`);
              paragraph.length = 0;
            }
            html.push(blocks[Number(codeToken[1])] || '');
            index += 1;
            continue;
          }
          paragraph.push(lines[index]);
          index += 1;
        }
        html.push(`<p>${renderInlineMarkdown(paragraph.join('<br>'))}</p>`);
      }
      return html.join('').replace(/@@CODE_(\d+)@@/g, (_, i) => blocks[Number(i)] || '');
    }

    function renderInlineMarkdown(text) {
      return text
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    renderCwdHistory();
    restoreOutputHistory();
    updateAgentUi();
    autoGrowPrompt();
    refresh();
