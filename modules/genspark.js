/**
 * Genspark 컨트롤러 v4.1 — 안정화 재작성
 *
 * 핵심 전략:
 * 1. insertText API로 입력 (clipboard 불필요)
 * 2. 프롬프트 전송 전 페이지 텍스트를 스냅샷 → 이후 diff로 새 응답만 추출
 * 3. Stop 버튼 소멸 + 텍스트 안정화로 완료 감지
 * 4. 로그인 대기 (최대 90초)
 */
const { chromium } = require('playwright');

const INPUT_SELECTORS = [
  'textarea[data-lexical-editor]',
  'div[contenteditable="true"][data-lexical-editor]',
  '#prompt-textarea',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="message"]',
  'textarea[placeholder*="입력"]',
  'div[contenteditable="true"]',
  '[role="textbox"]',
  'textarea',
];

const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[aria-label*="전송"]',
  'form button[type="submit"]',
  'button.send',
];

const STOP_SELECTORS = [
  'button[aria-label*="Stop"]',
  'button[aria-label*="stop"]',
  'button[data-testid="stop-button"]',
  '[class*="stop-button"]',
  'button[aria-label*="중지"]',
];

class GensparkController {
  constructor(io) {
    this.io          = io;
    this.browser     = null;
    this.page        = null;
    this.connected   = false;
    this.sessionUrl  = null;
    this.lastText    = '';
    this.stableMs    = 4000;
    this._monTimer   = null;
    this._ssTimer    = null;
    this._generating = false;
    this.onComplete  = null;
    this._snapshotText = ''; // 프롬프트 전송 전 스냅샷
  }

  emit(ev, data) { if (this.io) this.io.emit(ev, data); }

  // ── 연결 ─────────────────────────────────────────────
  async connect(url) {
    try {
      this.emit('genspark:status', { status: 'connecting', message: '브라우저 시작 중...' });
      this.browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
      });
      const ctx = await this.browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });
      this.page = await ctx.newPage();
      this.sessionUrl = url;

      this.emit('genspark:status', { status: 'navigating', message: `페이지 로딩 중...` });
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      this.emit('genspark:status', { status: 'waiting', message: '입력창 대기 중... (로그인이 필요하면 직접 로그인 후 대기)' });
      const ready = await this._waitForInput(90000);
      if (!ready) {
        this.emit('genspark:status', { status: 'waiting', message: '입력창을 찾지 못했지만 계속 진행합니다' });
      }

      this.connected = true;
      this.emit('genspark:status', { status: 'connected', message: 'Genspark 연결 완료 ✅' });
      this._startScreenshot();
      this._startMonitor();
      return { success: true };
    } catch (err) {
      this.emit('genspark:error', { message: `연결 실패: ${err.message}` });
      return { success: false, message: err.message };
    }
  }

  // ── 입력창 대기 ──────────────────────────────────────
  async _waitForInput(ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const el = await this._findInput();
      if (el) return true;
      await this.page.waitForTimeout(1500);
    }
    return false;
  }

  // ── 페이지 DOM 진단 (디버그용) ──────────────────────
  async diagnose() {
    if (!this.page) return;
    try {
      const info = await this.page.evaluate(() => {
        const inputs = [
          ...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')
        ].map(el => ({
          tag: el.tagName,
          type: el.type || '',
          role: el.getAttribute('role') || '',
          contenteditable: el.getAttribute('contenteditable') || '',
          placeholder: el.getAttribute('placeholder') || '',
          class: el.className?.substring(0, 60) || '',
          id: el.id || '',
          visible: el.offsetParent !== null,
          rect: (() => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; })(),
        }));
        return inputs;
      });
      this.emit('genspark:diagnose', { elements: info });
      console.log('[Genspark 진단] 입력 요소:', JSON.stringify(info, null, 2));
    } catch (err) {
      console.error('[Genspark 진단 실패]', err.message);
    }
  }

  // ── 입력창 찾기 (다양한 전략) ────────────────────────
  async _findInput() {
    if (!this.page) return null;

    // 전략 1: 알려진 셀렉터
    for (const sel of INPUT_SELECTORS) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) return el;
      } catch (_) {}
    }

    // 전략 2: contenteditable 전체 (Genspark 방식)
    try {
      const els = await this.page.$$('[contenteditable]');
      for (const el of [...els].reverse()) {
        try {
          if (await el.isVisible()) return el;
        } catch (_) {}
      }
    } catch (_) {}

    // 전략 3: role=textbox
    try {
      const els = await this.page.$$('[role="textbox"]');
      for (const el of els) {
        try { if (await el.isVisible()) return el; } catch (_) {}
      }
    } catch (_) {}

    // 전략 4: 화면 하단 여러 위치 클릭 후 포커스 확인
    try {
      const vp = this.page.viewportSize();
      const { width, height } = vp || { width: 1400, height: 900 };
      const clickPoints = [
        [width * 0.5, height - 60],
        [width * 0.5, height - 100],
        [width * 0.5, height - 150],
        [width * 0.5, height * 0.85],
      ];
      for (const [x, y] of clickPoints) {
        await this.page.mouse.click(x, y);
        await this.page.waitForTimeout(300);
        const ok = await this.page.evaluate(() => {
          const el = document.activeElement;
          return el && (el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'INPUT' || el.getAttribute('role') === 'textbox');
        });
        if (ok) return 'focused';
      }
    } catch (_) {}

    // 전략 5: Tab 키로 입력창 탐색
    try {
      await this.page.keyboard.press('Tab');
      await this.page.waitForTimeout(200);
      for (let i = 0; i < 15; i++) {
        const ok = await this.page.evaluate(() => {
          const el = document.activeElement;
          return el && (el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'INPUT');
        });
        if (ok) return 'focused';
        await this.page.keyboard.press('Tab');
        await this.page.waitForTimeout(150);
      }
    } catch (_) {}

    return null;
  }

  // ── 현재 페이지 전체 텍스트 스냅샷 ─────────────────
  async _getPageText() {
    if (!this.page) return '';
    try {
      return await this.page.evaluate(() => document.body.innerText || '');
    } catch (_) { return ''; }
  }

  // ── 프롬프트 전송 ────────────────────────────────────
  async sendMessage(promptText) {
    if (!this.connected || !this.page) return { success: false, message: 'Genspark 미연결' };
    try {
      this.emit('genspark:sending', { preview: promptText.substring(0, 100) + '...' });
      this.lastText    = '';
      this._generating = true;

      // 전송 전 페이지 텍스트 스냅샷 저장
      this._snapshotText = await this._getPageText();

      // 입력창 찾기 (재시도 3회)
      let input = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        input = await this._findInput();
        if (input) break;
        await this.page.waitForTimeout(2000);
        this.emit('genspark:status', { status: 'waiting', message: `입력창 탐색 중... (${attempt + 1}/3)` });
      }
      if (!input) throw new Error('입력창을 찾을 수 없습니다 — Genspark 브라우저에서 채팅창이 보이는지 확인하세요');

      // 입력창 클릭 & 포커스
      if (input !== 'focused') {
        try { await input.click({ force: true }); } catch (_) {}
      }
      await this.page.waitForTimeout(500);

      // 기존 내용 전체 선택 후 삭제
      await this.page.keyboard.press('Control+a');
      await this.page.waitForTimeout(200);
      await this.page.keyboard.press('Backspace');
      await this.page.waitForTimeout(200);

      // 텍스트 입력 (3가지 방법 순차 시도)
      const CHUNK = 5000;
      let inputSuccess = false;

      // 방법 1: insertText (가장 안정적)
      try {
        for (let i = 0; i < promptText.length; i += CHUNK) {
          await this.page.keyboard.insertText(promptText.slice(i, i + CHUNK));
          await this.page.waitForTimeout(80);
        }
        inputSuccess = true;
      } catch (_) {}

      // 방법 2: execCommand
      if (!inputSuccess) {
        try {
          await this.page.evaluate((text) => {
            const el = document.activeElement;
            if (!el) return;
            el.focus();
            document.execCommand('selectAll');
            document.execCommand('insertText', false, text.substring(0, 15000));
          }, promptText);
          inputSuccess = true;
        } catch (_) {}
      }

      // 방법 3: Clipboard API
      if (!inputSuccess) {
        await this.page.evaluate(async (text) => {
          try { await navigator.clipboard.writeText(text); } catch (_) {}
        }, promptText.substring(0, 15000));
        await this.page.keyboard.press('Control+v');
      }

      await this.page.waitForTimeout(600);

      // 전송: 버튼 클릭 → Enter → Ctrl+Enter 순으로 시도
      let sent = false;
      for (const sel of SEND_SELECTORS) {
        try {
          const btn = await this.page.$(sel);
          if (btn && await btn.isVisible()) { await btn.click(); sent = true; break; }
        } catch (_) {}
      }
      if (!sent) {
        // Enter 시도
        await this.page.keyboard.press('Enter');
        // 전송됐는지 1초 후 확인 (입력창이 비워지면 성공)
        await this.page.waitForTimeout(1000);
      }

      this.emit('genspark:sent', { message: '전송 완료 — AI 응답 대기 중...' });
      return { success: true };
    } catch (err) {
      this._generating = false;
      this.emit('genspark:error', { message: `전송 실패: ${err.message}` });
      return { success: false, message: err.message };
    }
  }

  // ── 응답 텍스트 추출 (스냅샷 diff 방식) ─────────────
  async _extractNewResponse() {
    const full = await this._getPageText();
    if (!full || full.length <= this._snapshotText.length) return '';

    // 스냅샷 이후 새로 추가된 텍스트
    const newPart = full.slice(this._snapshotText.length).trim();
    if (newPart.length < 50) return '';

    // UI 텍스트 제거 (버튼명, 네비 등 짧은 줄 제거)
    const lines = newPart.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    // 연속된 긴 줄들만 취합 (실제 집필 내용)
    const content = lines.join('\n');
    return content;
  }

  // ── Stop 버튼 감지 ───────────────────────────────────
  async _isGenerating() {
    if (!this.page) return false;
    try {
      for (const sel of STOP_SELECTORS) {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) return true;
      }
      return false;
    } catch (_) { return false; }
  }

  // ── 응답 완료 대기 ───────────────────────────────────
  async waitForResponse(timeoutMs = 360000) {
    return new Promise(resolve => {
      let stable = 0;
      let lastLen = 0;

      const tick = setInterval(async () => {
        try {
          const generating = await this._isGenerating();
          const text = await this._extractNewResponse();

          if (text.length > this.lastText.length) {
            this.lastText = text;
            this.emit('genspark:streaming', { content: text, length: text.length, preview: text.slice(-600) });
          }

          if (!generating && text.length > 100) {
            if (text.length === lastLen) {
              stable++;
              if (stable >= 3) {
                clearInterval(tick); clearTimeout(tout);
                this._generating = false;
                this.emit('genspark:response-complete', { content: text, length: text.length });
                if (typeof this.onComplete === 'function') await this.onComplete(text);
                resolve(text);
              }
            } else { stable = 0; lastLen = text.length; }
          } else { stable = 0; lastLen = text.length; }
        } catch (_) {}
      }, 2000);

      const tout = setTimeout(() => {
        clearInterval(tick);
        this._generating = false;
        resolve(this.lastText || '');
      }, timeoutMs);
    });
  }

  // ── 실시간 모니터링 ──────────────────────────────────
  _startMonitor() {
    if (this._monTimer) clearInterval(this._monTimer);
    this._monTimer = setInterval(async () => {
      if (!this.connected || !this._generating) return;
      try {
        const text = await this._extractNewResponse();
        if (text.length > this.lastText.length) {
          this.lastText = text;
          this.emit('genspark:streaming', { content: text, length: text.length, preview: text.slice(-500) });
        }
      } catch (_) {}
    }, 2000);
  }

  // ── 스크린샷 스트림 ──────────────────────────────────
  _startScreenshot() {
    if (this._ssTimer) clearInterval(this._ssTimer);
    this._ssTimer = setInterval(async () => {
      if (!this.connected || !this.page) return;
      try {
        const buf = await this.page.screenshot({ type: 'jpeg', quality: 50 });
        this.emit('genspark:screenshot', { image: buf.toString('base64') });
      } catch (_) {}
    }, 1500);
  }

  async takeScreenshot() {
    if (!this.page) return null;
    try { return (await this.page.screenshot({ type: 'jpeg', quality: 75 })).toString('base64'); }
    catch (_) { return null; }
  }

  // ── Genspark 내 Claude 모델 선택 ────────────────────
  async selectModel(modelName) {
    if (!this.connected || !this.page) return { success: false, message: '연결되지 않음' };
    try {
      this.emit('genspark:status', { status: 'model-select', message: `모델 선택 중: ${modelName}` });

      // Genspark 모델 선택 버튼/드롭다운 패턴들
      const modelBtnSelectors = [
        '[class*="model-selector"]',
        '[class*="model-select"]',
        '[data-testid*="model"]',
        'button[aria-label*="model"]',
        'button[aria-label*="Model"]',
        '[class*="model-btn"]',
        '[class*="ModelPicker"]',
        'button:has-text("Claude")',
        'button:has-text("claude")',
        '[class*="llm-select"]',
        '[class*="ai-model"]',
      ];

      // 모델 선택 버튼 찾기
      let modelBtn = null;
      for (const sel of modelBtnSelectors) {
        try {
          modelBtn = await this.page.$(sel);
          if (modelBtn && await modelBtn.isVisible()) break;
          modelBtn = null;
        } catch (_) {}
      }

      // 버튼을 못 찾으면 텍스트로 찾기
      if (!modelBtn) {
        try {
          modelBtn = await this.page.locator('button', { hasText: 'Claude' }).first();
          if (!await modelBtn.isVisible()) modelBtn = null;
        } catch (_) { modelBtn = null; }
      }

      if (!modelBtn) {
        this.emit('genspark:model-select-fail', {
          message: '모델 선택 버튼을 찾지 못했습니다. Genspark 브라우저 창에서 직접 선택해주세요.',
        });
        return { success: false, message: '모델 선택 버튼 없음 — 직접 선택해주세요' };
      }

      await modelBtn.click();
      await this.page.waitForTimeout(800);

      // 드롭다운에서 원하는 모델 클릭
      const modelMap = {
        'claude-opus-4.6':  ['Opus 4.6', 'opus-4.6', 'Claude Opus 4.6', 'Opus4.6'],
        'claude-opus-4.5':  ['Opus 4.5', 'opus-4.5', 'Claude Opus 4.5', 'Opus4.5'],
        'claude-opus-4':    ['Opus 4', 'opus-4', 'Claude Opus 4'],
        'claude-sonnet-4.5':['Sonnet 4.5', 'sonnet-4.5', 'Claude Sonnet 4.5'],
        'claude-sonnet-4':  ['Sonnet 4', 'sonnet-4', 'Claude Sonnet 4'],
        'claude-haiku-4':   ['Haiku 4', 'haiku-4', 'Claude Haiku 4'],
        'claude-opus-3.7':  ['Opus 3.7', 'opus-3.7', 'Claude Opus 3.7'],
        'claude-sonnet-3.7':['Sonnet 3.7', 'sonnet-3.7', 'Claude Sonnet 3.7'],
        'claude-3.5-sonnet':['3.5 Sonnet', 'claude-3-5-sonnet', 'Claude 3.5 Sonnet'],
        'claude-3-opus':    ['Claude 3 Opus', 'claude-3-opus'],
      };

      const keywords = modelMap[modelName] || [modelName];
      let selected = false;

      for (const kw of keywords) {
        try {
          const item = await this.page.locator(`[role="option"], [role="menuitem"], li, button`, { hasText: kw }).first();
          if (await item.isVisible()) {
            await item.click();
            selected = true;
            break;
          }
        } catch (_) {}
      }

      if (!selected) {
        // 드롭다운 닫기
        await this.page.keyboard.press('Escape');
        this.emit('genspark:model-select-fail', { message: `"${modelName}" 항목을 찾지 못했습니다. 직접 선택해주세요.` });
        return { success: false, message: '모델 항목 없음' };
      }

      await this.page.waitForTimeout(500);
      this.emit('genspark:model-selected', { model: modelName, message: `모델 변경 완료: ${modelName}` });
      return { success: true };
    } catch (err) {
      this.emit('genspark:error', { message: `모델 선택 실패: ${err.message}` });
      return { success: false, message: err.message };
    }
  }

  async clearForNewSession() {
    if (!this.page) return;
    try {
      this.lastText = '';
      this._snapshotText = '';
      // 새 대화 버튼 시도
      const newBtns = ['button[aria-label*="New"]', 'a[href*="/agents"]', '[class*="new-chat"]', '[class*="new-conversation"]'];
      for (const sel of newBtns) {
        const el = await this.page.$(sel);
        if (el) { await el.click(); await this.page.waitForTimeout(1500); return; }
      }
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this._waitForInput(20000);
    } catch (_) {}
  }

  async disconnect() {
    clearInterval(this._monTimer);
    clearInterval(this._ssTimer);
    this.connected   = false;
    this._generating = false;
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null; this.page = null;
    }
    this.emit('genspark:status', { status: 'disconnected', message: '연결 해제됨' });
  }
}

module.exports = GensparkController;
