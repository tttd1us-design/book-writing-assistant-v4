/**
 * 세션 관리 — 자동 저장 / 복원
 */
const fs   = require('fs');
const path = require('path');

const SESSION_PATH = path.join(__dirname, '..', 'data', 'session.json');

class SessionManager {
  constructor() {
    this.state = null;
  }

  // ── 상태 참조 주입 ──────────────────────────────────
  bind(stateRef) { this.state = stateRef; }

  // ── 저장 ────────────────────────────────────────────
  save() {
    if (!this.state) return;
    try {
      const data = {
        bookTitle:    this.state.bookTitle,
        bookBible:    this.state.bookBible,
        chapters:     this.state.chapters.map(ch => ({
          ...ch, content: ch.content ? ch.content.substring(0, 500) : '', // 내용은 축약 저장
        })),
        totalWritten: this.state.totalWritten,
        context:      this.state.context?.toJSON?.() || {},
        masterDocId:  this.state.masterDocId,
        targetDocId:  this.state.targetDocId,
        savedAt:      new Date().toISOString(),
      };
      fs.writeFileSync(SESSION_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {}
  }

  // ── 복원 ────────────────────────────────────────────
  load() {
    try {
      if (!fs.existsSync(SESSION_PATH)) return null;
      return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    } catch (_) { return null; }
  }

  // ── 챕터 내용 개별 저장 ─────────────────────────────
  saveChapterContent(chapterId, content) {
    try {
      const p = path.join(__dirname, '..', 'data', `chapter_${chapterId}.txt`);
      fs.writeFileSync(p, content, 'utf8');
    } catch (_) {}
  }

  // ── 챕터 내용 불러오기 ──────────────────────────────
  loadChapterContent(chapterId) {
    try {
      const p = path.join(__dirname, '..', 'data', `chapter_${chapterId}.txt`);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    } catch (_) { return ''; }
  }
}

module.exports = new SessionManager();
