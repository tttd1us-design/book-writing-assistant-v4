/**
 * Google Docs 연동 — GWS CLI
 * - 기존 문서 지정 저장 (중복 방지)
 * - 문서 제목 변경
 * - Drive 파일 검색/목록
 */
const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const GWS     = 'C:\\Users\\tttd1\\AppData\\Roaming\\npm\\node_modules\\@googleworkspace\\cli\\run.js';
const MAX_BUF = 30 * 1024 * 1024;

class GoogleDocsManager {
  constructor(io) {
    this.io          = io;
    this.masterDocId = null;
    this.targetDocId = null;
  }

  emit(ev, data) { if (this.io) this.io.emit(ev, data); }
  isReady()      { return !!this.masterDocId; }

  _exec(args) {
    return JSON.parse(
      execFileSync('node', [GWS, ...args], { encoding: 'utf8', maxBuffer: MAX_BUF })
    );
  }

  // ── 저장 대상 문서 지정 ─────────────────────────────
  setTargetDoc(docIdOrUrl) {
    const match = (docIdOrUrl || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    const docId = match ? match[1] : docIdOrUrl.trim();
    if (!docId) return { success: false, message: '유효하지 않은 Google Docs URL/ID' };
    this.targetDocId = docId;
    this.masterDocId = docId;
    this.emit('gdocs:target-set', { docId, url: this.getDocUrl() });
    return { success: true, docId };
  }

  // ── 마스터 문서 생성 or 기존 문서 재사용 ─────────────
  async createOrReuseDoc(bookTitle) {
    if (this.targetDocId) {
      this.masterDocId = this.targetDocId;
      this.emit('gdocs:ready', { docId: this.masterDocId, url: this.getDocUrl(), reused: true });
      await this.appendContent(`\n\n${'═'.repeat(60)}\n집필 세션: ${new Date().toLocaleString('ko-KR')}\n${'═'.repeat(60)}\n\n`);
      return { success: true, docId: this.masterDocId };
    }
    try {
      const doc = this._exec(['docs','documents','create','--json', JSON.stringify({ title: `[집필중] ${bookTitle}` })]);
      this.masterDocId = doc.documentId;
      await this.appendContent(`${bookTitle}\n\n집필 시작: ${new Date().toLocaleDateString('ko-KR')}\n\n${'─'.repeat(40)}\n\n`);
      this.emit('gdocs:ready', { docId: this.masterDocId, url: this.getDocUrl(), reused: false });
      return { success: true, docId: this.masterDocId };
    } catch (err) {
      this.emit('gdocs:error', { message: `문서 생성 실패: ${err.message}` });
      return { success: false, message: err.message };
    }
  }

  // ── 내용 추가 ────────────────────────────────────────
  async appendContent(content) {
    if (!this.masterDocId) return { success: false, message: '문서가 설정되지 않음' };
    try {
      const doc      = this._exec(['docs','documents','get','--params', JSON.stringify({ documentId: this.masterDocId })]);
      const endIndex = doc.body?.content?.slice(-1)[0]?.endIndex || 1;
      this._exec([
        'docs','documents','batchUpdate',
        '--params', JSON.stringify({ documentId: this.masterDocId }),
        '--json',   JSON.stringify({ requests: [{ insertText: { location: { index: Math.max(1, endIndex - 1) }, text: content } }] }),
      ]);
      this.emit('gdocs:saved', { chars: content.length });
      return { success: true };
    } catch (err) {
      this.emit('gdocs:error', { message: err.message.substring(0, 100) });
      return { success: false, message: err.message };
    }
  }

  // ── 챕터 저장 ────────────────────────────────────────
  async saveChapter(chapter, content) {
    const header = `\n\n${'═'.repeat(60)}\nPART ${chapter.partNum} — ${chapter.title}\n${'─'.repeat(40)}\n\n`;
    const result = await this.appendContent(header + content + '\n\n');

    // 로컬 백업
    try {
      fs.writeFileSync(
        path.join(__dirname, '..', 'data', `chapter_${chapter.id}.txt`),
        content, 'utf8'
      );
    } catch (_) {}

    this.emit('gdocs:chapter-saved', { id: chapter.id, title: chapter.title, chars: content.length, url: this.getDocUrl() });
    return result;
  }

  // ── 문서 읽기 (기획서) ──────────────────────────────
  async readDoc(docUrl) {
    const match = docUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return { success: false, message: '유효하지 않은 Google Docs URL' };
    try {
      const doc  = this._exec(['docs','documents','get','--params', JSON.stringify({ documentId: match[1] })]);
      let   text = '';
      for (const el of doc.body?.content || []) {
        if (el.paragraph) {
          for (const pe of el.paragraph.elements || []) {
            if (pe.textRun?.content) text += pe.textRun.content;
          }
        }
      }
      return { success: true, text: text.trim(), title: doc.title, docId: match[1] };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // ── 문서 제목 변경 ───────────────────────────────────
  async renameDoc(newTitle) {
    if (!this.masterDocId) return { success: false };
    try {
      this._exec(['drive','files','update','--params', JSON.stringify({ fileId: this.masterDocId }), '--json', JSON.stringify({ name: newTitle })]);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // ── Drive 파일 검색 ──────────────────────────────────
  async searchFiles(query, limit = 15) {
    try {
      const result = this._exec(['drive','files','list','--params', JSON.stringify({
        q: query, pageSize: limit,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
        orderBy: 'modifiedTime desc',
      })]);
      return { success: true, files: result.files || [] };
    } catch (err) {
      return { success: false, files: [], message: err.message };
    }
  }

  // ── Drive 최근 파일 ──────────────────────────────────
  async listRecentFiles(limit = 20) {
    try {
      const result = this._exec(['drive','files','list','--params', JSON.stringify({
        pageSize: limit, orderBy: 'modifiedTime desc',
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
      })]);
      return { success: true, files: result.files || [] };
    } catch (err) {
      return { success: false, files: [], message: err.message };
    }
  }

  getDocUrl() {
    return this.masterDocId ? `https://docs.google.com/document/d/${this.masterDocId}/edit` : null;
  }
}

module.exports = GoogleDocsManager;
