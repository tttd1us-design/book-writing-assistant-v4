/**
 * 자동 집필 엔진
 * - 챕터 순서대로 자동 집필
 * - 3회 재시도 (지수 백오프)
 * - 분량 부족 시 자동 재생성
 * - 예상 잔여 시간 표시
 */
const PromptBuilder = require('./prompt-builder');

class AutoWriter {
  constructor(io, claude, gemini, context, gdocs, sessionMgr) {
    this.io         = io;
    this.claude     = claude;
    this.gemini     = gemini;
    this.context    = context;
    this.gdocs      = gdocs;
    this.session    = sessionMgr;
    this.running    = false;
    this.paused     = false;
    this.chapters   = [];
    this.bookBible  = null;
    this.startTime  = null;
    this.doneCount  = 0;
  }

  emit(ev, data) { if (this.io) this.io.emit(ev, data); }

  // ── 자동 집필 시작 ──────────────────────────────────
  async start(chapters, bookBible) {
    if (this.running) return { success: false, message: '이미 실행 중' };
    if (!this.claude.isReady()) return { success: false, message: 'Claude API 키를 먼저 설정하세요' };

    this.chapters  = chapters;
    this.bookBible = bookBible;
    this.running   = true;
    this.paused    = false;
    this.startTime = Date.now();
    this.doneCount = chapters.filter(c => c.status === 'done').length;

    this.emit('auto:start', { total: chapters.length, done: this.doneCount });
    this._run();
    return { success: true };
  }

  pause()  { this.paused = true;  this.emit('auto:paused',  {}); }
  resume() { this.paused = false; this.emit('auto:resumed', {}); this._run(); }
  stop()   { this.running = false; this.claude.stopStream(); this.emit('auto:stopped', {}); }

  // ── 내부 실행 루프 ──────────────────────────────────
  async _run() {
    while (this.running) {
      if (this.paused) { await this._sleep(1000); continue; }

      const ch = this.chapters.find(c => c.status === 'pending');
      if (!ch) {
        this.running = false;
        const total = this.chapters.reduce((s, c) => s + (c.writtenChars || 0), 0);
        this.emit('auto:complete', {
          total,
          chapters: this.chapters.length,
          done: this.chapters.filter(c => c.status === 'done').length,
        });
        break;
      }

      await this._writeChapter(ch);
    }
  }

  // ── 챕터 집필 (재시도 포함) ─────────────────────────
  async _writeChapter(ch) {
    const MAX_RETRY = 3;
    let attempt = 0;

    while (attempt < MAX_RETRY) {
      try {
        ch.status = 'writing';
        this.emit('auto:chapter-start', { id: ch.id, title: ch.title, attempt });

        // 컨텍스트 블록 생성
        const contextBlock = this.context.buildContextBlock(ch.id);
        const prompt = PromptBuilder.build(ch, this.bookBible, contextBlock, ch.id);

        // Claude 호출
        const result = await this.claude.writeChapter(prompt, ch.targetChars, ch.id);

        if (!result.success) throw new Error(result.message);

        // 분량 검증
        if (result.chars < ch.targetChars * 0.6) {
          attempt++;
          this.emit('auto:retry', { id: ch.id, chars: result.chars, target: ch.targetChars, attempt });
          await this._sleep(2000 * attempt);
          continue;
        }

        // 성공 처리
        ch.content      = result.content;
        ch.writtenChars = result.chars;
        ch.status       = 'done';
        this.doneCount++;

        // 챕터 요약 생성
        const summary = await this.gemini.summarizeChapter(ch, result.content);
        ch.chapterSummary = summary;
        this.context.saveChapterSummary(ch.id, summary);

        // Google Docs 저장
        if (this.gdocs.isReady()) {
          await this.gdocs.saveChapter(ch, result.content);
        }

        // 세션 저장
        this.session.save();

        // 진행률 계산
        const elapsed   = (Date.now() - this.startTime) / 1000;
        const avgPerCh  = elapsed / this.doneCount;
        const remaining = (this.chapters.filter(c => c.status === 'pending').length) * avgPerCh;
        const totalWritten = this.chapters.reduce((s, c) => s + (c.writtenChars || 0), 0);

        this.emit('auto:chapter-done', {
          id: ch.id, title: ch.title, chars: result.chars,
          totalWritten, done: this.doneCount,
          total: this.chapters.length,
          remainingSeconds: Math.round(remaining),
          progress: Math.round(this.doneCount / this.chapters.length * 100),
        });

        await this._sleep(2000); // 챕터 간 안정화 대기
        return;

      } catch (err) {
        attempt++;
        this.emit('auto:retry', { id: ch.id, error: err.message, attempt });
        if (attempt >= MAX_RETRY) {
          ch.status = 'error';
          ch.error  = err.message;
          this.emit('auto:chapter-error', { id: ch.id, title: ch.title, error: err.message });
          return;
        }
        await this._sleep(Math.pow(2, attempt) * 3000);
      }
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = AutoWriter;
