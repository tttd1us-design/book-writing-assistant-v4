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

// ── BookBible 항상 유효하게 유지 ─────────────────────
function getBookBible() {
  if (!state.bookBible) {
    state.bookBible = {
      title: state.bookTitle || '도서',
      characters: [], themes: [], keywords: [],
      prohibitedWords: [], writingStyle: '',
    };
  }
  // 제목이 없거나 기본값이면 항상 최신 bookTitle 사용
  if (!state.bookBible.title || state.bookBible.title === '도서') {
    state.bookBible.title = state.bookTitle || '도서';
  }
  return state.bookBible;
}

// ── Google Docs 자동 보장 (없으면 자동 생성) ──────────
async function ensureGdocs() {
  if (gdocs.isReady()) return true;
  const title = state.bookTitle || '도서집필도우미_자동저장';
  io.emit('gdocs:status', { message: 'Google Docs 자동 생성 중...' });
  const r = await gdocs.createOrReuseDoc(title);
  if (r.success) {
    state.masterDocId = r.docId;
    SessionManager.save();
    io.emit('gdocs:ready', { docId: r.docId, url: gdocs.getDocUrl(), reused: false });
  }
  return r.success;
}

// ── 챕터 저장 공통 함수 ──────────────────────────────
async function saveChapterAuto(ch, content) {
  if (!ch || !content || content.length < 50) return;
  const ok = await ensureGdocs();
  if (ok) {
    await gdocs.saveChapter(ch, content);
  } else {
    io.emit('gdocs:error', { message: 'Google Docs 저장 실패 — 로컬에만 저장됨' });
  }
  SessionManager.saveChapterContent(ch.id, content);
  SessionManager.save();
}

// Genspark → Google Docs 자동 저장 콜백
genspark.onComplete = async (content) => {
  if (!content || content.length < 100) return;
  const ch = state.chapters.find(c => c.status === 'writing');
  if (ch) {
    ch.content = content; ch.writtenChars = content.length; ch.status = 'done';
    state.totalWritten = state.chapters.reduce((s,c) => s + (c.writtenChars||0), 0);
    await saveChapterAuto(ch, content);
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
  const prompt = PromptBuilder.build(ch, getBookBible(), contextBlock, ch.id);

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

// Genspark로 목차 생성
app.post('/api/genspark/generate-toc', async (req, res) => {
  const { text, bookTitle, totalTarget } = req.body;
  if (!genspark.connected) return res.json({ success: false, message: 'Genspark 미연결' });
  if (!text) return res.json({ success: false, message: '텍스트 필요' });

  const target = parseInt(totalTarget) || 4000000;
  const title  = bookTitle || state.bookTitle || '도서';
  if (title && title !== '도서') state.bookTitle = title;

  const prompt = `아래 기획서를 분석해서 도서 『${title}』의 목차를 JSON 배열로 만들어주세요.

기획서:
${text.substring(0, 30000)}

규칙:
1. type은 반드시: 프롤로그, 르포, 에세이, 대화, 에필로그 중 하나
2. partNum: 프롤로그=0, PART1=1, PART2=2, PART3=3, PART4=4, 에필로그=5
3. 총 targetChars 합계 = ${target.toLocaleString()}자에 근접
4. title 값에 큰따옴표(") 사용 금지
5. 반드시 JSON 배열만 출력. 설명 문장 없이.

출력 형식:
[{"id":1,"num":1,"type":"프롤로그","title":"제목","partNum":0,"targetChars":20000},{"id":2,"num":2,"type":"르포","title":"제목","partNum":1,"targetChars":50000}]`;

  io.emit('status:change', { status: 'analyzing', message: 'Genspark(Claude Opus 4.6)로 목차 생성 중...' });
  const result = await genspark.generate(prompt, 300000);

  if (!result.success) {
    io.emit('status:change', { status: 'idle', message: '목차 생성 실패' });
    return res.json(result);
  }

  // JSON 파싱
  try {
    const cleaned = result.text.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '');
    const start   = cleaned.indexOf('[');
    const end     = cleaned.lastIndexOf(']');
    if (start === -1 || end <= start) throw new Error('JSON 배열 없음');
    const raw = JSON.parse(cleaned.slice(start, end + 1));
    const chapters = raw.map((ch, i) => ({
      id: ch.id||i+1, num: ch.num||i+1, type: ch.type||'르포',
      title: ch.title||`챕터 ${i+1}`, partNum: ch.partNum??1,
      targetChars: ch.targetChars||Math.floor(target/raw.length),
      status:'pending', writtenChars:0, content:'', chapterSummary:'',
    }));
    state.chapters  = chapters;
    state.bookBible = { title: state.bookTitle, characters:[], themes:[], keywords:[], prohibitedWords:[], writingStyle:'' };
    context.initFromBible(state.bookBible);
    state.status = 'ready';
    SessionManager.save();
    io.emit('outline:generated', { chapters, bookTitle: state.bookTitle });
    io.emit('status:change', { status: 'ready', message: `Genspark 목차 ${chapters.length}개 생성 완료` });
    res.json({ success: true, chapters });
  } catch (err) {
    io.emit('status:change', { status: 'idle', message: '목차 파싱 실패' });
    // 파싱 실패 시 raw 텍스트라도 반환
    res.json({ success: false, message: err.message, rawText: result.text.substring(0, 500) });
  }
});

// Genspark로 스토리텔링 생성
app.post('/api/genspark/generate-story', async (req, res) => {
  if (!genspark.connected) return res.json({ success: false, message: 'Genspark 미연결' });
  if (!state.chapters.length) return res.json({ success: false, message: '목차가 없습니다' });

  const title = state.bookTitle || '도서';
  const tocText = state.chapters.map(ch =>
    `CH.${ch.num} [${ch.type}] ${ch.title} (목표 ${(ch.targetChars/1000).toFixed(0)}k자)`
  ).join('\n');

  const prompt = `도서 『${title}』의 전체 목차를 보고 각 챕터의 스토리 흐름을 작성해주세요.

목차:
${tocText}

각 챕터마다 다음 형식으로 작성:
**CH.번호 — 챕터제목**
이 챕터에서 다룰 핵심 스토리, 등장인물의 상황, 독자에게 전달할 메시지를 2~3문장으로.

전체 챕터를 PART 순서대로 빠짐없이 작성하세요.`;

  io.emit('status:change', { status: 'analyzing', message: 'Genspark로 스토리텔링 생성 중...' });
  const result = await genspark.generate(prompt, 300000);
  io.emit('status:change', { status: 'ready', message: '스토리텔링 생성 완료' });

  if (result.success) {
    // 챕터별 요약 파싱해서 저장
    const lines = result.text.split('\n');
    let currentChNum = null;
    let summaryLines = [];
    const summaries = {};

    for (const line of lines) {
      const match = line.match(/\*\*CH\.(\d+)|CH\.(\d+)\s*—/);
      if (match) {
        if (currentChNum && summaryLines.length) {
          summaries[parseInt(currentChNum)] = summaryLines.join(' ').trim();
        }
        currentChNum = match[1] || match[2];
        summaryLines = [];
      } else if (currentChNum && line.trim()) {
        summaryLines.push(line.trim());
      }
    }
    if (currentChNum && summaryLines.length) {
      summaries[parseInt(currentChNum)] = summaryLines.join(' ').trim();
    }

    // 챕터에 summary 반영
    state.chapters.forEach(ch => {
      if (summaries[ch.num]) ch.summary = summaries[ch.num].substring(0, 200);
    });
    SessionManager.save();
    io.emit('story:generated', { storyText: result.text, chapters: state.chapters });
  }
  res.json(result);
});

// Genspark로 기획서 분석/보강
app.post('/api/genspark/analyze-plan', async (req, res) => {
  if (!genspark.connected) return res.json({ success: false, message: 'Genspark 미연결' });
  const { text } = req.body;
  if (!text) return res.json({ success: false, message: '기획서 텍스트 필요' });

  const prompt = `아래 도서 기획서를 분석하고 핵심 내용을 구조화해서 정리해주세요.

기획서 원문:
${text.substring(0, 20000)}

다음 항목을 명확하게 정리해주세요:
1. 도서 제목 및 부제
2. 핵심 주제와 메시지
3. 주요 등장인물 (이름, 나이, 직업, 역할)
4. 각 PART별 핵심 내용
5. 독자 대상
6. 예상 분량 및 구성`;

  io.emit('status:change', { status: 'analyzing', message: 'Genspark로 기획서 분석 중...' });
  const result = await genspark.generate(prompt, 180000);
  io.emit('status:change', { status: 'ready', message: '기획서 분석 완료' });
  res.json(result);
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

// ── 목차 생성 공통 함수 (우선순위: Genspark → Gemini → Claude) ──
async function generateOutlineAuto(planningText, totalTarget) {
  const target = parseInt(totalTarget) || 4000000;

  // 1순위: Genspark (연결돼 있으면 항상 Genspark 사용)
  if (genspark.connected) {
    io.emit('status:change', { status: 'analyzing', message: '🤖 Genspark(Claude Opus 4.6)로 목차 생성 중...' });
    const prompt = buildTocPrompt(planningText, state.bookTitle || '도서', target);
    const gsResult = await genspark.generate(prompt, 300000);
    if (gsResult.success) {
      return parseTocFromText(gsResult.text, target);
    }
    io.emit('status:change', { status: 'analyzing', message: 'Genspark 응답 파싱 실패 → Gemini로 전환...' });
  }

  // 2순위: Gemini
  if (gemini.isReady()) {
    io.emit('status:change', { status: 'analyzing', message: 'Gemini로 목차 생성 중...' });
    const r = await gemini.generateOutline(planningText, target);
    if (r.success) return r;
    io.emit('status:change', { status: 'analyzing', message: 'Gemini 실패 → Claude로 전환 중...' });
  }

  // 3순위: Claude
  if (claude.isReady()) {
    io.emit('status:change', { status: 'analyzing', message: 'Claude로 목차 생성 중...' });
    return await claude.generateOutline(planningText, target);
  }

  return { success: false, message: 'AI가 연결되지 않았습니다. Genspark 또는 API 키를 연결하세요.' };
}

// 목차 생성 프롬프트 빌더
function buildTocPrompt(text, title, target) {
  return `아래 기획서를 분석해서 도서 『${title}』의 목차를 JSON 배열로 만들어주세요.

기획서:
${text.substring(0, 30000)}

규칙:
1. type은 반드시: 프롤로그, 르포, 에세이, 대화, 에필로그 중 하나
2. partNum: 프롤로그=0, PART1=1, PART2=2, PART3=3, PART4=4, 에필로그=5
3. 총 targetChars 합계 = ${target.toLocaleString()}자에 근접
4. title 값에 큰따옴표 사용 금지
5. 반드시 JSON 배열만 출력. 설명 문장 없이.

출력 형식:
[{"id":1,"num":1,"type":"프롤로그","title":"제목","partNum":0,"targetChars":20000},{"id":2,"num":2,"type":"르포","title":"제목","partNum":1,"targetChars":50000}]`;
}

// 텍스트에서 목차 JSON 파싱
function parseTocFromText(text, totalTarget) {
  try {
    const cleaned = text.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '');
    const start = cleaned.indexOf('[');
    const end   = cleaned.lastIndexOf(']');
    if (start === -1 || end <= start) throw new Error('JSON 배열 없음');
    const raw = JSON.parse(cleaned.slice(start, end + 1));
    const chapters = raw.map((ch, i) => ({
      id: ch.id||i+1, num: ch.num||i+1, type: ch.type||'르포',
      title: ch.title||`챕터 ${i+1}`, partNum: ch.partNum??1,
      targetChars: ch.targetChars||Math.floor(totalTarget/raw.length),
      status:'pending', writtenChars:0, content:'', chapterSummary:'',
    }));
    return { success: true, chapters };
  } catch (err) {
    return { success: false, message: `파싱 실패: ${err.message}` };
  }
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
    // bookBible 초기화 (제목 포함)
    state.bookBible = { title: state.bookTitle, characters: [], themes: [], keywords: [], prohibitedWords: [], writingStyle: '' };
    context.initFromBible(state.bookBible);
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
    // bookBible 초기화
    state.bookBible = { title: state.bookTitle, characters: [], themes: [], keywords: [], prohibitedWords: [], writingStyle: '' };
    context.initFromBible(state.bookBible);
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

  // 파일명 인코딩 수정 (mojibake 방지)
  let originalname = req.file.originalname;
  try {
    // Latin-1로 잘못 읽힌 UTF-8 바이트를 복구
    const buf = Buffer.from(originalname, 'latin1');
    if (buf.toString('utf8') !== originalname) originalname = buf.toString('utf8');
  } catch (_) {}

  const result = await FileParser.parse(req.file.path, originalname);
  result.filename = originalname;
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  res.json(result);
});

// ══════════════════════════════════════════════════════
// API — Gemini 목차 대화 & 채팅
// ══════════════════════════════════════════════════════

app.post('/api/gemini/refine-toc', async (req, res) => {
  const { message, totalTarget } = req.body;
  if (!message) return res.json({ success: false, message: '메시지 필요' });
  const target = parseInt(totalTarget) || 4000000;

  let result;

  // Genspark 우선
  if (genspark.connected) {
    const tocSummary = state.chapters.map((ch,i) => `${i+1}. [P${ch.partNum}/${ch.type}] ${ch.title} (${(ch.targetChars/1000).toFixed(0)}k자)`).join('\n');
    const prompt = `현재 도서 목차를 아래 요청에 따라 수정해주세요.

현재 목차:
${tocSummary}

수정 요청: ${message}

수정된 전체 목차를 JSON 배열로만 출력하세요. 설명 없이.
[{"id":1,"num":1,"type":"프롤로그","title":"제목","partNum":0,"targetChars":20000},...]`;

    const gsResult = await genspark.generate(prompt, 180000);
    if (gsResult.success) {
      result = parseTocFromText(gsResult.text, target);
      if (result.success) result.response = gsResult.text;
      else result = { success: true, response: gsResult.text, updatedChapters: null };
    }
  }

  // fallback
  if (!result?.success) {
    if (gemini.isReady()) result = await gemini.refineTOC(message, state.chapters, target);
    if (!result?.success && claude.isReady()) result = await claude.refineTOC(message, state.chapters, target);
  }

  if (!result) return res.json({ success: false, message: 'AI가 연결되지 않음 — Genspark를 연결하세요' });

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

  // Genspark 우선
  if (genspark.connected) {
    const prompt = `당신은 도서 집필 전문 AI 비서입니다. [도서: ${ctx.bookTitle || '제목미설정'} / 챕터: ${ctx.chaptersCount}개 / 작성: ${ctx.writtenChars.toLocaleString()}자]\n\n${message}`;
    const gsResult = await genspark.generate(prompt, 120000);
    if (gsResult.success) {
      io.emit('gemini:chat-response', { message: gsResult.text });
      return res.json({ success: true, response: gsResult.text });
    }
  }

  let result;
  if (gemini.isReady()) result = await gemini.chat(message, ctx);
  if (!result?.success && claude.isReady()) result = await claude.chat(message, ctx);
  if (!result) return res.json({ success: false, message: 'AI가 연결되지 않음 — Genspark를 연결하세요' });
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
  const prompt = PromptBuilder.build(ch, getBookBible(), contextBlock, ch.id);
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
  const prompt = PromptBuilder.build(ch, getBookBible(), contextBlock, ch.id);

  res.json({ success: true, message: '집필 시작' });

  const result = await claude.writeChapter(prompt, ch.targetChars, ch.id);
  if (result.success) {
    ch.content = result.content; ch.writtenChars = result.chars; ch.status = 'done';
    state.totalWritten = state.chapters.reduce((s, c) => s + (c.writtenChars || 0), 0);
    const summary = await (gemini.isReady() ? gemini : claude).summarizeChapter(ch, result.content);
    ch.chapterSummary = summary;
    context.saveChapterSummary(ch.id, summary);
    await saveChapterAuto(ch, result.content);   // 자동 저장 (없으면 자동 생성)
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
  // bookBible 항상 갱신
  getBookBible().title = state.bookTitle;
  context.bookTitle    = state.bookTitle;
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
  // bookBible 항상 유효하게
  getBookBible(); // 없으면 자동 생성, title 동기화
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
