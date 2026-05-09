/**
 * Genspark 컨트롤러 v5 — 셀렉터 없는 범용 방식
 *
 * 핵심 전략:
 * 1. networkidle까지 완전 로딩 대기
 * 2. 화면 하단 클릭 → 키보드로 바로 입력 (DOM 구조 무관)
 * 3. 전송 전 페이지 텍스트 스냅샷 → diff로 새 응답 추출
 * 4. Stop 버튼 또는 텍스트 안정화로 완료 감지
 */
const { chromium } = require('playwright');

class GensparkController {
  constructor(io) {
    this.io          = io;
    this.browser     = null;
    this.page        = null;
    this.connected   = false;
    this.sessionUrl  = null;
    this.lastText    = '';
    this._monTimer   = null;
    this._ssTimer    = null;
    this._generating = false;
    this.onComplete  = null;
    this._snapshotText = '';
  }

  emit(ev, data) { if (this.io) this.io.emit(ev, data); }

  // ── 연결 ─────────────────────────────────────────────
  async connect(url) {
    try {
      this.emit('genspark:status', { status: 'connecting', message: '브라우저 시작 중...' });

      this.browser = await chromium.launch({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1400,900',
          '--start-maximized',
        ],
      });

      const ctx = await this.browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });

      this.page = await ctx.newPage();
      this.sessionUrl = url;

      this.emit('genspark:status', { status: 'navigating', message: '페이지 로딩 중 (완전 로딩 대기)...' });

      // networkidle까지 완전히 기다림
      await this.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
        .catch(() => this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));

      // React 렌더링 완료까지 추가 대기
      await this.page.waitForTimeout(3000);

      this.emit('genspark:status', { status: 'waiting', message: '로그인이 필요하면 브라우저에서 직접 로그인하세요 (90초 대기)' });

      // 입력창 찾을 때까지 대기 (최대 90초)
      await this._waitForReady(90000);

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

  // ── 페이지 준비 대기 ─────────────────────────────────
  async _waitForReady(ms = 90000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // 입력 가능한 요소가 하나라도 있으면 OK
      const hasInput = await this.page.evaluate(() => {
        const inputs = document.querySelectorAll(
          'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], input[type="text"]'
        );
        return [...inputs].some(el => el.offsetParent !== null);
      }).catch(() => false);

      if (hasInput) return true;
      await this.page.waitForTimeout(1500);
    }
    return false;
  }

  // ── 페이지 전체 텍스트 스냅샷 ──────────────────────
  async _getPageText() {
    if (!this.page) return '';
    try {
      return await this.page.evaluate(() => {
        // 메인 콘텐츠 영역만 추출 (버튼, 메뉴 등 제외)
        const main = document.querySelector('main, [role="main"], #root, .app') || document.body;
        return main.innerText || document.body.innerText || '';
      });
    } catch (_) { return ''; }
  }

  // ── 프롬프트 전송 (좌표 기반 클릭 + 키보드 직접 입력) ──
  async sendMessage(promptText) {
    if (!this.connected || !this.page) return { success: false, message: 'Genspark 미연결' };

    try {
      this.emit('genspark:sending', { preview: promptText.substring(0, 100) + '...' });
      this.lastText    = '';
      this._generating = true;

      // 전송 전 스냅샷
      this._snapshotText = await this._getPageText();

      const vp = this.page.viewportSize() || { width: 1400, height: 900 };

      // ── STEP 1: 하단 입력창 클릭 ──
      let clicked = false;

      // 방법 A: 알려진 요소 직접 클릭
      const inputFound = await this.page.evaluate(() => {
        const selectors = [
          'textarea',
          '[contenteditable="true"]',
          '[contenteditable=""]',
          '[role="textbox"]',
          'input[type="text"]',
        ];
        for (const sel of selectors) {
          const els = [...document.querySelectorAll(sel)];
          const visible = els.filter(el => el.offsetParent !== null);
          if (visible.length > 0) {
            const last = visible[visible.length - 1];
            last.click();
            last.focus();
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (inputFound) {
        clicked = true;
        await this.page.waitForTimeout(400);
      }

      // 방법 B: 화면 하단 여러 위치 클릭
      if (!clicked) {
        const positions = [
          { x: vp.width * 0.5, y: vp.height - 65 },
          { x: vp.width * 0.5, y: vp.height - 100 },
          { x: vp.width * 0.5, y: vp.height - 140 },
          { x: vp.width * 0.5, y: vp.height * 0.88 },
          { x: vp.width * 0.5, y: vp.height * 0.92 },
        ];
        for (const pos of positions) {
          await this.page.mouse.click(pos.x, pos.y);
          await this.page.waitForTimeout(300);
          const focused = await this.page.evaluate(() => {
            const el = document.activeElement;
            return el && el !== document.body && (
              el.tagName === 'TEXTAREA' ||
              el.tagName === 'INPUT' ||
              el.isContentEditable ||
              el.getAttribute('role') === 'textbox'
            );
          }).catch(() => false);
          if (focused) { clicked = true; break; }
        }
      }

      // 방법 C: Tab 키로 포커스 탐색
      if (!clicked) {
        for (let i = 0; i < 10; i++) {
          await this.page.keyboard.press('Tab');
          await this.page.waitForTimeout(150);
          const ok = await this.page.evaluate(() => {
            const el = document.activeElement;
            return el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
          }).catch(() => false);
          if (ok) { clicked = true; break; }
        }
      }

      // ── STEP 2: 기존 내용 지우기 ──
      await this.page.keyboard.press('Control+a');
      await this.page.waitForTimeout(200);
      await this.page.keyboard.press('Backspace');
      await this.page.waitForTimeout(200);

      // ── STEP 3: 텍스트 입력 ──
      // insertText 방식 (가장 빠르고 안정적)
      const CHUNK = 4000;
      for (let i = 0; i < promptText.length; i += CHUNK) {
        await this.page.keyboard.insertText(promptText.slice(i, i + CHUNK));
        await this.page.waitForTimeout(100);
      }
      await this.page.waitForTimeout(600);

      // 입력 확인 — 텍스트가 실제로 입력됐는지 체크
      const inputted = await this.page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return false;
        return (el.value || el.innerText || el.textContent || '').length > 10;
      }).catch(() => false);

      // 입력 실패 시 execCommand로 재시도
      if (!inputted) {
        await this.page.evaluate((text) => {
          const el = document.activeElement;
          if (!el) return;
          try {
            el.focus();
            document.execCommand('selectAll');
            document.execCommand('insertText', false, text.substring(0, 12000));
          } catch (_) {
            if (el.value !== undefined) el.value = text.substring(0, 12000);
          }
        }, promptText);
        await this.page.waitForTimeout(400);
      }

      // ── STEP 4: 전송 ──
      let sent = false;

      // 전송 버튼 클릭 시도
      sent = await this.page.evaluate(() => {
        const btnSelectors = [
          'button[data-testid="send-button"]',
          'button[aria-label*="Send"]',
          'button[type="submit"]',
          'button.send',
          '[class*="send"][class*="btn"]',
          '[class*="submit"]',
        ];
        for (const sel of btnSelectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) {
            btn.click();
            return true;
          }
        }
        // 아이콘 버튼 중 입력창 옆 마지막 버튼
        const allBtns = [...document.querySelectorAll('button')];
        const visibleBtns = allBtns.filter(b => b.offsetParent !== null);
        if (visibleBtns.length > 0) {
          visibleBtns[visibleBtns.length - 1].click();
          return true;
        }
        return false;
      }).catch(() => false);

      if (!sent) {
        await this.page.keyboard.press('Enter');
      }

      await this.page.waitForTimeout(1000);

      this.emit('genspark:sent', { message: '전송 완료 — AI 응답 대기 중...' });
      return { success: true };
    } catch (err) {
      this._generating = false;
      this.emit('genspark:error', { message: `전송 실패: ${err.message}` });
      return { success: false, message: err.message };
    }
  }

  // ── 새 응답 텍스트 추출 (스냅샷 diff) ──────────────
  async _extractNewResponse() {
    const full = await this._getPageText();
    if (!full || full.length <= this._snapshotText.length + 50) return '';

    // 스냅샷 이후 추가된 텍스트
    const newPart = full.slice(this._snapshotText.length).trim();

    // 너무 짧으면 무시
    if (newPart.length < 80) return '';

    // UI 텍스트(짧은 줄들) 필터링
    const lines = newPart.split('\n');
    const contentLines = lines.filter(l => l.trim().length > 3);
    return contentLines.join('\n').trim();
  }

  // ── Stop 버튼 감지 ───────────────────────────────────
  async _isGenerating() {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        const stopKw = ['stop', 'Stop', '중지', '멈춤', 'Cancel'];
        const btns = [...document.querySelectorAll('button, [role="button"]')];
        return btns.some(b => {
          if (!b.offsetParent) return false;
          const text = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
          return stopKw.some(k => text.includes(k.toLowerCase()));
        });
      });
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
              if (stable >= 4) {  // 8초간 변화 없음 = 완료
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
        const finalText = this.lastText || '';
        if (finalText.length > 100 && typeof this.onComplete === 'function') {
          this.onComplete(finalText);
        }
        resolve(finalText);
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
    }, 2500);
  }

  // ── 스크린샷 스트림 ──────────────────────────────────
  _startScreenshot() {
    if (this._ssTimer) clearInterval(this._ssTimer);
    this._ssTimer = setInterval(async () => {
      if (!this.connected || !this.page) return;
      try {
        const buf = await this.page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
        this.emit('genspark:screenshot', { image: buf.toString('base64') });
      } catch (_) {}
    }, 1500);
  }

  // ── 단발성 생성: 프롬프트 보내고 완성된 응답 반환 ────
  async generate(promptText, timeoutMs = 300000) {
    if (!this.connected) return { success: false, message: 'Genspark 미연결' };

    this.emit('genspark:generating', { message: '생성 중...' });

    // 채팅 초기화 후 전송
    await this.clearForNewSession();
    await this.page?.waitForTimeout(1500);

    const sendResult = await this.sendMessage(promptText);
    if (!sendResult.success) return { success: false, message: sendResult.message };

    const text = await this.waitForResponse(timeoutMs);
    if (!text || text.length < 50) return { success: false, message: '응답이 비어있습니다' };

    this.emit('genspark:generated', { length: text.length });
    return { success: true, text };
  }

  // ── 진단 ─────────────────────────────────────────────
  async diagnose() {
    if (!this.page) return;
    try {
      const info = await this.page.evaluate(() => {
        const inputs = [
          ...document.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]')
        ].map(el => ({
          tag: el.tagName, type: el.type || '',
          role: el.getAttribute('role') || '',
          contenteditable: el.getAttribute('contenteditable') || '',
          placeholder: el.placeholder || el.getAttribute('placeholder') || '',
          class: (el.className || '').substring(0, 60),
          id: el.id || '',
          visible: el.offsetParent !== null,
          rect: (() => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; })(),
        }));
        return { inputs, url: location.href, title: document.title };
      });
      this.emit('genspark:diagnose', info);
    } catch (err) {
      this.emit('genspark:error', { message: `진단 실패: ${err.message}` });
    }
  }

  // ── 모델 선택 ────────────────────────────────────────
  async selectModel(modelName) {
    if (!this.connected || !this.page) return { success: false, message: '연결되지 않음' };
    try {
      this.emit('genspark:status', { status: 'model-select', message: `모델 선택 중: ${modelName}` });

      const modelMap = {
        'claude-opus-4.6':  ['Opus 4.6', 'Claude Opus 4.6'],
        'claude-opus-4.5':  ['Opus 4.5', 'Claude Opus 4.5'],
        'claude-opus-4':    ['Opus 4', 'Claude Opus 4'],
        'claude-sonnet-4.5':['Sonnet 4.5', 'Claude Sonnet 4.5'],
        'claude-sonnet-4':  ['Sonnet 4', 'Claude Sonnet 4'],
        'claude-haiku-4':   ['Haiku 4', 'Claude Haiku 4'],
        'claude-opus-3.7':  ['Opus 3.7', 'Claude Opus 3.7'],
        'claude-3.5-sonnet':['3.5 Sonnet', 'Claude 3.5 Sonnet'],
      };

      const keywords = modelMap[modelName] || [modelName];

      // 모델 선택 버튼 찾기 (텍스트에 Claude 포함)
      const clicked = await this.page.evaluate((kws) => {
        const all = [...document.querySelectorAll('button, [role="option"], [role="menuitem"], li, [class*="model"]')];
        for (const el of all) {
          const text = el.innerText || el.textContent || '';
          if (kws.some(k => text.includes(k))) {
            el.click();
            return true;
          }
        }
        return false;
      }, keywords);

      if (clicked) {
        await this.page.waitForTimeout(500);
        this.emit('genspark:model-selected', { model: modelName, message: `모델 변경: ${modelName}` });
        return { success: true };
      }

      this.emit('genspark:model-select-fail', { message: `Genspark 브라우저에서 직접 모델을 선택해주세요.` });
      return { success: false, message: '모델 버튼 없음 — 직접 선택' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  async takeScreenshot() {
    if (!this.page) return null;
    try { return (await this.page.screenshot({ type: 'jpeg', quality: 75 })).toString('base64'); }
    catch (_) { return null; }
  }

  async clearForNewSession() {
    if (!this.page) return;
    try {
      this.lastText = '';
      this._snapshotText = '';
      await this.page.reload({ waitUntil: 'networkidle' }).catch(() => {});
      await this.page.waitForTimeout(2000);
      await this._waitForReady(20000);
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
