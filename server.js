/**
 * 도서집필도우미 v4 — 메인 서버
 * Genspark + Claude API 선택 + Gemini + GWS CLI
 */
require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');

const GeminiModule      = require('./modules/gemini');
const ClaudeModule      = require('./modules/claude');
const GensparkController = require('./modules/genspark');
const FileParser        = require('./modules/file-parser');
const ContextManager    = require('./modules/context-manager');
const PromptBuilder     = require('./modules/prompt-builder');
const AutoWriter        = require('./modules/auto-writer');
const SessionManager    = require('./modules/session-manager');
const GoogleDocsManager = require('./modules/google-docs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e8 });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'data', 'uploads'), limits: { fileSize: 50 * 1024 * 1024 } });

// ── 전역 상태 ──────────────────────────────────────────
let state = {
  bookTitle:    '',
  bookBible:    null,
  chapters:     [],
  totalWritten: 0,
  masterDocId:  null,
  targetDocId:  null,
  status:       'idle',
};

// ── 모듈 초기화 ────────────────────────────────────────
const gemini    = new GeminiModule(io);
const claude    = new ClaudeModule(io);
const genspark  = new GensparkController(io);
const context   = new ContextManager();
const gdocs     = new GoogleDocsManager(io);
const autoWriter = new AutoWriter(io, claude, gemini, context, gdocs, SessionManager);

// Genspark → Google Docs 자동 저장 콜백
genspark.onComplete = async (content) => {
  if (!content || content.length < 100) return;
  const ch = state.chapters.find(c => c.status === 'writing');
  if (ch) {
    ch.content = content; ch.writtenChars = content.length; ch.status = 'done';
    state.totalWritten = state.chapters.reduce((s,c) => s + (c.writtenChars||0), 0);
    if (gdocs.isReady()) await gdocs.saveChapter(ch, content);
    SessionManager.saveChapterContent(ch.id, content);
    SessionManager.save();
    io.emit('chapter:done', { id: ch.id, title: ch.title, chars: content.length, totalWritten: state.totalWritten });
  }
};

SessionManager.bind(state);
state.context = context;

// ══════════════════════════════════════════════════════
// API — 설정
// ══════════════════════════════════════════════════════

app.post('/api/gemini/init', (req, res) => {
  const { apiKey, model } = req.body;
  try { gemini.init(apiKey, model); res.json({ success: true, model: gemini.modelName }); }
  catch (err) { res.json({ success: false, message: err.message }); }
});

app.get('/api/gemini/models', async (req, res) => {
  const models = await gemini.listModels();
  res.json({ models });
});

app.post('/api/claude/init', (req, res) => {
  const { apiKey, model } = req.body;
  try { claude.init(apiKey, model); res.json({ success: true, model: claude.model }); }
  catch (err) { res.json({ success: false, message: err.message }); }
});

app.get('/api/status', (req, res) => {
  res.json({
    gemini: gemini.isReady(), claude: claude.isReady(),
    genspark: genspark.connected,
    gdocs: gdocs.isReady(), status: state.status,
    chapters: state.chapters.length,
    totalWritten: state.totalWritten,
    docUrl: gdocs.getDocUrl(),
  });
});

// ══════════════════════════════════════════════════════
// API — Genspark
// ══════════════════════════════════════════════════════

app.post('/api/genspark/connect', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.json({ success: false, message: 'URL 필요' });
  const result = await genspark.connect(url);
  res.json(result);
});

app.post('/api/genspark/disconnect', async (req, res) => {
  await genspark.disconnect();
  res.json({ success: true });
});

app.post('/api/genspark/send', async (req, res) => {
  const { chapterId } = req.body;
  const ch = state.chapters.find(c => c.id === parseInt(chapterId));
  if (!ch) return res.json({ success: false, message: '챕터 없음' });
  if (!genspark.connected) return res.json({ success: false, message: 'Genspark 미연결' });

  const contextBlock = context.buildContextBlock(ch.id);
  const prompt = PromptBuilder.build(ch, state.bookBible, contextBlock, ch.id);

  ch.status = 'writing';
  io.emit('chapter:writing', { id: ch.id, title: ch.title });

  res.json({ success: true, message: '전송 시작' });

  // 비동기 실행
  (async () => {
    const sendResult = await genspark.sendMessage(prompt);
    if (!sendResult.success) {
      ch.status = 'error';
      io.emit('chapter:error', { id: ch.id, message: sendResult.message });
      return;
    }
    // 응답 대기 (onComplete 콜백에서 자동 처리)
    await genspark.waitForResponse(300000);
  })();
});

app.post('/api/genspark/clear', async (req, res) => {
  await genspark.clearForNewSession();
  res.json({ success: true });
});

app.post('/api/genspark/diagnose', async (req, res) => {
  await genspark.diagnose();
  res.json({ success: true });
});

app.post('/api/genspark/select-model', async (req, res) => {
  const { model } = req.body;
  if (!model) return res.json({ success: false, message: '모델명 필요' });
  const result = await genspark.selectModel(model);
  res.json(result);
});

app.get('/api/genspark/screenshot', async (req, res) => {
  const image = await genspark.takeScreenshot();
  res.json({ image });
});

// Genspark 수동 저장 (사용자가 복사한 텍스트 직접 입력)
app.post('/api/genspark/manual-save', async (req, res) => {
  const { content, chapterId } = req.body;
  if (!content) return res.json({ success: false, message: '내용 없음' });
  const ch = state.chapters.find(c => c.id === parseInt(chapterId));
  if (ch) {
    ch.content = content; ch.writtenChars = content.length; ch.status = 'done';
    state.totalWritten = state.chapters.reduce((s,c) => s + (c.writtenChars||0), 0);
    if (gdocs.isReady()) await gdocs.saveChapter(ch, content);
    SessionManager.saveChapterContent(ch.id, content);
    SessionManager.save();
    io.emit('chapter:done', { id: ch.id, title: ch.title, chars: content.length, totalWritten: state.totalWritten });
  } else if (gdocs.isReady()) {
    await gdocs.appendContent(content);
  }
  res.json({ success: true, chars: content.length });
});

// ══════════════════════════════════════════════════════
// API — 기획서 분석 & 목차 생성
// ══════════════════════════════════════════════════════

// ── 목차 생성 공통 함수 (Gemini 실패 시 Claude 자동 대체) ──
async function generateOutlineAuto(planningText, totalTarget) {
  const target = parseInt(totalTarget) || 4000000;

  // Gemini 우선 시도
  if (gemini.isReady()) {
    io.emit('status:change', { status: 'analyzing', message: 'Gemini로 목차 생성 중...' });
    const r = await gemini.generateOutline(planningText, target);
    if (r.success) return r;
    io.emit('status:change', { status: 'analyzing', message: `Gemini 실패 → Claude로 전환 중...` });
  }

  // Claude fallback
  if (claude.isReady()) {
    io.emit('status:change', { status: 'analyzing', message: 'Claude로 목차 생성 중...' });
    return await claude.generateOutline(planningText, target);
  }

  return { success: false, message: 'Gemini와 Claude 모두 연결되지 않았습니다. API 키를 설정하세요.' };
}

// Google Docs URL에서 기획서 읽기 → AI 분석
app.post('/api/outline/from-url', async (req, res) => {
  const { docUrl, totalTarget } = req.body;
  if (!docUrl) return res.json({ success: false, message: 'URL 필요' });
  if (!gemini.isReady() && !claude.isReady()) return res.json({ success: false, message: 'Gemini 또는 Claude API 키를 먼저 설정하세요' });

  io.emit('status:change', { status: 'analyzing', message: 'Google Docs 기획서 읽는 중...' });
  const readResult = await gdocs.readDoc(docUrl);
  if (!readResult.success) {
    io.emit('status:change', { status: 'idle', message: '기획서 읽기 실패' });
    return res.json(readResult);
  }

  const result = await generateOutlineAuto(readResult.text, totalTarget);
  if (result.success) {
    state.chapters  = result.chapters;
    state.bookTitle = readResult.title || state.bookTitle;
    state.status    = 'ready';
    SessionManager.save();
    io.emit('outline:generated', { chapters: result.chapters, bookTitle: state.bookTitle });
    io.emit('status:change', { status: 'ready', message: `목차 ${result.chapters.length}개 생성 완료` });
  } else {
    io.emit('status:change', { status: 'idle', message: '목차 생성 실패' });
  }
  res.json(result);
});

// 업로드된 파일 텍스트로 AI 분석
app.post('/api/outline/from-text', async (req, res) => {
  const { text, bookTitle, totalTarget } = req.body;
  if (!text) return res.json({ success: false, message: '텍스트 필요' });
  if (!gemini.isReady() && !claude.isReady()) return res.json({ success: false, message: 'Gemini 또는 Claude API 키를 먼저 설정하세요' });

  if (bookTitle) state.bookTitle = bookTitle;
  const result = await generateOutlineAuto(text, totalTarget);
  if (result.success) {
    state.chapters = result.chapters;
    state.status   = 'ready';
    SessionManager.save();
    io.emit('outline:generated', { chapters: result.chapters, bookTitle: state.bookTitle });
    io.emit('status:change', { status: 'ready', message: `목차 ${result.chapters.length}개 생성 완료` });
  } else {
    io.emit('status:change', { status: 'idle', message: '목차 생성 실패' });
  }
  res.json(result);
});

// ══════════════════════════════════════════════════════
// API — 파일 업로드
// ══════════════════════════════════════════════════════

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.json({ success: false, message: '파일 없음' });
  const result = await FileParser.parse(req.file.path, req.file.originalname);
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  res.json(result);
});

// ══════════════════════════════════════════════════════
// API — Gemini 목차 대화 & 채팅
// ══════════════════════════════════════════════════════

app.post('/api/gemini/refine-toc', async (req, res) => {
  const { message, totalTarget } = req.body;
  if (!message) return res.json({ success: false, message: '메시지 필요' });
  let result;
  if (gemini.isReady()) {
    result = await gemini.refineTOC(message, state.chapters, parseInt(totalTarget) || 4000000);
    if (!result.success && claude.isReady()) {
      result = await claude.refineTOC(message, state.chapters, parseInt(totalTarget) || 4000000);
    }
  } else if (claude.isReady()) {
    result = await claude.refineTOC(message, state.chapters, parseInt(totalTarget) || 4000000);
  } else {
    return res.json({ success: false, message: 'AI가 연결되지 않음' });
  }
  if (result.success && result.updatedChapters) {
    state.chapters = result.updatedChapters;
    io.emit('outline:updated', { chapters: result.updatedChapters });
    SessionManager.save();
  }
  res.json(result);
});

app.post('/api/gemini/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.json({ success: false, message: '메시지 필요' });
  const ctx = { bookTitle: state.bookTitle, chaptersCount: state.chapters.length, writtenChars: state.totalWritten };
  let result;
  if (gemini.isReady()) {
    result = await gemini.chat(message, ctx);
    if (!result.success && claude.isReady()) result = await claude.chat(message, ctx);
  } else if (claude.isReady()) {
    result = await claude.chat(message, ctx);
  } else {
    return res.json({ success: false, message: 'Gemini 또는 Claude API 키를 먼저 설정하세요' });
  }
  res.json(result);
});

app.post('/api/gemini/review', async (req, res) => {
  const { totalTarget } = req.body;
  const review = await gemini.reviewOutline(state.chapters, parseInt(totalTarget) || 4000000);
  res.json({ success: !!review, review });
});

app.post('/api/gemini/clear-toc',  (req, res) => { gemini.clearTocHistory();  res.json({ success: true }); });
app.post('/api/gemini/clear-chat', (req, res) => { gemini.clearChatHistory(); res.json({ success: true }); });

// ── 집필 프롬프트 생성 API ────────────────────────────
app.post('/api/writing-prompt', (req, res) => {
  const { chapterId } = req.body;
  const ch = state.chapters.find(c => c.id === parseInt(chapterId));
  if (!ch) return res.json({ success: false, message: '챕터 없음' });
  const contextBlock = context.buildContextBlock(ch.id);
  const prompt = PromptBuilder.build(ch, state.bookBible, contextBlock, ch.id);
  ch.prompt = prompt;
  res.json({ success: true, prompt, chapter: { id: ch.id, title: ch.title } });
});

// ══════════════════════════════════════════════════════
// API — 목차 관리
// ══════════════════════════════════════════════════════

app.get('/api/chapters', (req, res) => {
  res.json({ chapters: state.chapters, totalWritten: state.totalWritten });
});

app.post('/api/chapters/reset', (req, res) => {
  state.chapters    = [];
  state.totalWritten = 0;
  state.bookBible   = null;
  SessionManager.save();
  io.emit('outline:reset', {});
  res.json({ success: true });
});

app.delete('/api/chapters/:id', (req, res) => {
  const id = parseInt(req.params.id);
  state.chapters = state.chapters.filter(c => c.id !== id);
  io.emit('outline:updated', { chapters: state.chapters });
  SessionManager.save();
  res.json({ success: true });
});

app.delete('/api/chapters/batch', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.json({ success: false });
  state.chapters = state.chapters.filter(c => !ids.includes(c.id));
  io.emit('outline:updated', { chapters: state.chapters });
  SessionManager.save();
  res.json({ success: true });
});

app.patch('/api/chapters/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const ch = state.chapters.find(c => c.id === id);
  if (!ch) return res.json({ success: false });
  Object.assign(ch, req.body);
  io.emit('outline:updated', { chapters: state.chapters });
  SessionManager.save();
  res.json({ success: true, chapter: ch });
});

// 수동 집필 (단일 챕터 Claude 호출)
app.post('/api/chapters/:id/write', async (req, res) => {
  const id = parseInt(req.params.id);
  const ch = state.chapters.find(c => c.id === id);
  if (!ch) return res.json({ success: false, message: '챕터 없음' });
  if (!claude.isReady()) return res.json({ success: false, message: 'Claude API 키를 먼저 설정하세요' });

  const contextBlock = context.buildContextBlock(ch.id);
  const prompt = PromptBuilder.build(ch, state.bookBible, contextBlock, ch.id);

  res.json({ success: true, message: '집필 시작' });

  const result = await claude.writeChapter(prompt, ch.targetChars, ch.id);
  if (result.success) {
    ch.content = result.content; ch.writtenChars = result.chars; ch.status = 'done';
    state.totalWritten = state.chapters.reduce((s, c) => s + (c.writtenChars || 0), 0);
    const summary = await gemini.summarizeChapter(ch, result.content);
    ch.chapterSummary = summary;
    context.saveChapterSummary(ch.id, summary);
    if (gdocs.isReady()) await gdocs.saveChapter(ch, result.content);
    SessionManager.saveChapterContent(ch.id, result.content);
    SessionManager.save();
    io.emit('chapter:done', { id, title: ch.title, chars: result.chars, totalWritten: state.totalWritten });
  }
});

// ══════════════════════════════════════════════════════
// API — 자동 집필
// ══════════════════════════════════════════════════════

app.post('/api/auto/start', async (req, res) => {
  const result = await autoWriter.start(state.chapters, state.bookBible);
  res.json(result);
});

app.post('/api/auto/pause',  (req, res) => { autoWriter.pause();  res.json({ success: true }); });
app.post('/api/auto/resume', (req, res) => { autoWriter.resume(); res.json({ success: true }); });
app.post('/api/auto/stop',   (req, res) => { autoWriter.stop();   res.json({ success: true }); });

// ══════════════════════════════════════════════════════
// API — Google Docs
// ══════════════════════════════════════════════════════

app.post('/api/gdocs/set-target', (req, res) => {
  const { docUrl } = req.body;
  const result = gdocs.setTargetDoc(docUrl);
  if (result.success) { state.targetDocId = result.docId; state.masterDocId = result.docId; SessionManager.save(); }
  res.json(result);
});

app.post('/api/gdocs/create', async (req, res) => {
  const result = await gdocs.createOrReuseDoc(state.bookTitle || '도서');
  if (result.success) { state.masterDocId = result.docId; SessionManager.save(); }
  res.json({ ...result, docUrl: gdocs.getDocUrl() });
});

app.post('/api/gdocs/save-chapter', async (req, res) => {
  const { chapterId, content } = req.body;
  const ch = state.chapters.find(c => c.id === parseInt(chapterId));
  if (!ch) return res.json({ success: false, message: '챕터 없음' });
  const result = await gdocs.saveChapter(ch, content || ch.content || '');
  res.json(result);
});

app.get('/api/gdocs/info', (req, res) => {
  res.json({ masterDocId: gdocs.masterDocId, targetDocId: gdocs.targetDocId, docUrl: gdocs.getDocUrl() });
});

// Drive 파일 검색
app.get('/api/drive/search', async (req, res) => {
  const { q } = req.query;
  const result = await gdocs.searchFiles(q || 'mimeType="application/vnd.google-apps.document"');
  res.json(result);
});

// Drive 최근 파일
app.get('/api/drive/recent', async (req, res) => {
  const result = await gdocs.listRecentFiles(20);
  res.json(result);
});

// ══════════════════════════════════════════════════════
// API — 도서 제목
// ══════════════════════════════════════════════════════

app.post('/api/book/title', async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.json({ success: false });
  state.bookTitle = title.trim();
  if (state.bookBible) state.bookBible.title = state.bookTitle;
  const renamed = await gdocs.renameDoc(`[집필중] ${state.bookTitle}`);
  SessionManager.save();
  io.emit('book:title-updated', { title: state.bookTitle });
  res.json({ success: true, title: state.bookTitle, docRenamed: renamed.success });
});

// ══════════════════════════════════════════════════════
// Socket.io
// ══════════════════════════════════════════════════════

io.on('connection', (socket) => {
  socket.emit('state:init', {
    status: state.status, bookTitle: state.bookTitle,
    chapters: state.chapters, totalWritten: state.totalWritten,
    masterDocId: gdocs.masterDocId, docUrl: gdocs.getDocUrl(),
    geminiReady: gemini.isReady(), claudeReady: claude.isReady(),
  });
});

// ══════════════════════════════════════════════════════
// 세션 복원
// ══════════════════════════════════════════════════════
function restoreSession() {
  const saved = SessionManager.load();
  if (!saved) return;
  state.bookTitle    = saved.bookTitle    || '';
  state.bookBible    = saved.bookBible    || null;
  state.totalWritten = saved.totalWritten || 0;
  state.masterDocId  = saved.masterDocId  || null;
  state.targetDocId  = saved.targetDocId  || null;

  // 챕터 복원 (내용은 파일에서 로드)
  state.chapters = (saved.chapters || []).map(ch => ({
    ...ch,
    content: SessionManager.loadChapterContent(ch.id),
  }));

  if (state.targetDocId) gdocs.setTargetDoc(state.targetDocId);
  else if (state.masterDocId) gdocs.masterDocId = state.masterDocId;

  if (saved.context) context.fromJSON(saved.context);
}

// ── 서버 시작 ──────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log('  📚 도서집필도우미 v4 시작');
  console.log(`${'═'.repeat(50)}`);
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log(`${'═'.repeat(50)}\n`);
  restoreSession();
});
