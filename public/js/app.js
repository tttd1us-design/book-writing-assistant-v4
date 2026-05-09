/**
 * 도서집필도우미 v4 — 프론트엔드
 */
const socket = io();

// ── 상태 ────────────────────────────────────────────
let state = {
  chapters: [], bookTitle: '', totalWritten: 0,
  currentChapterId: null, status: 'idle',
  docUrl: null, geminiReady: false, claudeReady: false,
};
let selectedIds     = new Set();
let uploadedFile    = null;
let writingContent  = '';
let drivePickerMode = 'planning';
let driveSelectedFile = null;
let writeEngine     = 'genspark';
let gsCurrentText   = '';
let isAnalyzing     = false;   // 중복 분석 방지

// ════════════════════════════════════════════════════
// Socket 이벤트
// ════════════════════════════════════════════════════

socket.on('state:init', d => { Object.assign(state, d); renderAll(); });

socket.on('status:change', ({ status, message }) => {
  state.status = status;
  updateStatusBadge(status);
  addLog(message, status === 'error' ? 'error' : 'info');
  // 분석 중일 때 로딩 메시지 실시간 갱신
  if (isAnalyzing && status === 'analyzing') {
    const lt = document.getElementById('loadingText');
    if (lt) lt.textContent = message;
  }
  if (status === 'ready' || status === 'idle') {
    isAnalyzing = false;
    setAnalyzeBtn(false);
  }
});

// ── Genspark 이벤트 ──────────────────────────────────
socket.on('genspark:status', ({ status, message }) => {
  addLog(`[Genspark] ${message}`, status === 'connected' ? 'success' : 'info');
  const connected = status === 'connected';
  updateGsModalBadge(connected);
  if (connected) {
    state.gensparkConnected = true;
    const btn = document.getElementById('gsHeaderBtn');
    if (btn) { btn.textContent = '🟢 Genspark 연결됨'; btn.style.background = 'rgba(76,175,122,0.25)'; }
    showToast('🟢 Genspark 연결 완료 — 목차/스토리/채팅 모두 Genspark 사용', 'success');
    hideLoading();
    updateAnalyzeBtnLabel(true);
  } else if (status === 'disconnected') {
    state.gensparkConnected = false;
    const btn = document.getElementById('gsHeaderBtn');
    if (btn) { btn.textContent = '🤖 Genspark 연결'; btn.style.background = 'rgba(76,175,122,0.15)'; }
    updateAnalyzeBtnLabel(false);
  }
});

socket.on('genspark:generating', ({ message }) => { addLog(`🤖 Genspark: ${message}`, 'info'); });
socket.on('genspark:generated', ({ length }) => { addLog(`✅ Genspark 생성 완료 — ${length.toLocaleString()}자`, 'success'); });

socket.on('story:generated', ({ storyText, chapters }) => {
  state.chapters = chapters;
  hideLoading();
  renderStory();
  addLog('✅ Genspark 스토리텔링 생성 완료', 'success');
  showToast('스토리텔링 생성 완료', 'success');
});
socket.on('genspark:sending',  ({ preview }) => { addLog(`📤 전송: ${preview.substring(0,60)}...`, 'info'); });
socket.on('genspark:sent',     ({ message }) => { addLog(`✅ ${message}`, 'success'); });
socket.on('genspark:error',    ({ message }) => { addLog(`❌ Genspark: ${message}`, 'error'); showToast(message, 'error'); });
socket.on('genspark:screenshot', ({ image }) => {
  // P3 탭 내 이미지
  const img = document.getElementById('gsScreenImg');
  const ph  = document.getElementById('gsPlaceholder');
  if (img) { img.src = `data:image/jpeg;base64,${image}`; if (img.style.display === 'none') { img.style.display = 'block'; if (ph) ph.style.display = 'none'; } }
  // 모달 이미지
  const mimg = document.getElementById('gsModalScreen');
  const mph  = document.getElementById('gsModalPlaceholder');
  if (mimg) { mimg.src = `data:image/jpeg;base64,${image}`; if (mimg.style.display === 'none') { mimg.style.display = 'block'; if (mph) mph.style.display = 'none'; } }
});
socket.on('genspark:streaming', ({ content, length }) => {
  gsCurrentText  = content;
  writingContent = content;

  const tail = content.length > 1500 ? '...\n\n' + content.substring(content.length - 1200) : content;

  // Genspark 탭
  const tc = document.getElementById('gsTextContent');
  if (tc) { tc.textContent = tail; tc.scrollTop = tc.scrollHeight; }
  const lenEl = document.getElementById('gsTextLen');
  if (lenEl) lenEl.textContent = `${length.toLocaleString()}자`;
  const mt = document.getElementById('gsModalText');
  if (mt) { mt.textContent = tail; mt.scrollTop = mt.scrollHeight; }
  const ml = document.getElementById('gsModalLen');
  if (ml) ml.textContent = `${length.toLocaleString()}자`;

  // 집필 스트림 탭 — 자동 전환 + 내용 표시
  switchTab('write');
  switchWriteTab('stream');   // 반드시 스트림 탭으로 전환
  const ws = document.getElementById('writingStream');
  if (ws) { ws.textContent = content; ws.scrollTop = ws.scrollHeight; }
  document.getElementById('wcChars').textContent = `${length.toLocaleString()}자`;
  const ch = state.chapters.find(c => c.id === state.currentChapterId);
  const pct = ch?.targetChars ? Math.min(100, Math.round(length / ch.targetChars * 100)) : 0;
  document.getElementById('wcProgBar').style.width = `${pct}%`;
  document.getElementById('stopBtn').style.display = '';
});

socket.on('genspark:response-complete', ({ content, length }) => {
  gsCurrentText  = content;
  writingContent = content;
  addLog(`✅ Genspark 응답 완료 — ${length.toLocaleString()}자`, 'success');
  showToast(`${length.toLocaleString()}자 — Google Docs 저장 중...`, 'success');

  // 집필 스트림 탭 최종 업데이트
  const ws = document.getElementById('writingStream');
  if (ws) { ws.textContent = content; ws.scrollTop = ws.scrollHeight; }
  document.getElementById('wcChars').textContent = `${length.toLocaleString()}자`;
  document.getElementById('stopBtn').style.display = 'none';
  document.getElementById('saveContentBtn').style.display = '';

  // 집필 스트림 탭으로 자동 전환
  switchTab('write');
});

socket.on('gemini:ready',        ({ message }) => { state.geminiReady = true;  setBadge('geminibadge', 'Gemini ✅', 'ok');   addLog(message, 'success'); showToast(message, 'success'); });
socket.on('gemini:analyzing',    ({ message }) => { addLog(message, 'info'); showLoading(message); });
socket.on('gemini:thinking',     ({ message }) => { addLog(message, 'info'); });
socket.on('gemini:outline-done', ({ chapters, count }) => { state.chapters = chapters; hideLoading(); renderTOC(); updateStats(); addLog(`목차 생성 완료 — ${count}개`, 'success'); showToast(`${count}개 챕터 목차 생성됨`, 'success'); });
socket.on('gemini:toc-response', ({ message, updatedChapters }) => {
  addTocChatMsg('model', message);
  if (updatedChapters) { state.chapters = updatedChapters; renderTOC(); updateStats(); showToast('목차 업데이트됨', 'success'); }
});
socket.on('gemini:chat-response', ({ message }) => {
  hideThinking();
  appendChatMsg('model', message);
  document.getElementById('chatSend').disabled = false;
});
socket.on('gemini:chat-thinking', () => showThinking());
socket.on('gemini:error',  ({ message }) => { hideLoading(); addLog(`Gemini 오류: ${message}`, 'error'); showToast(message, 'error'); });

socket.on('log:debug',           ({ message }) => { addLog(`🔍 ${message}`, 'info'); });
socket.on('claude:ready',        ({ message }) => { state.claudeReady = true; setBadge('claudebadge', 'Claude ✅', 'ok'); addLog(message, 'success'); showToast(message, 'success'); });
socket.on('claude:analyzing',    ({ message }) => { addLog(message, 'info'); });
socket.on('claude:outline-done', ({ chapters, count }) => { state.chapters = chapters; hideLoading(); renderTOC(); updateStats(); document.getElementById('tocStats').style.display = 'flex'; addLog(`Claude 목차 완료 — ${count}개`, 'success'); showToast(`${count}개 챕터 생성됨`, 'success'); });
socket.on('claude:toc-response', ({ message, updatedChapters }) => { addTocChatMsg('model', message); if (updatedChapters) { state.chapters = updatedChapters; renderTOC(); updateStats(); showToast('목차 업데이트됨', 'success'); } });
socket.on('claude:chat-response',({ message }) => { hideThinking(); appendChatMsg('model', message); document.getElementById('chatSend').disabled = false; });
socket.on('claude:start',    ({ chapterId }) => { writingContent = ''; showWritingPane(chapterId); addLog('Claude 집필 시작...', 'info'); });
socket.on('claude:streaming', ({ chunk, total, progress }) => {
  writingContent += chunk;
  const ws = document.getElementById('writingStream');
  if (ws) ws.textContent = writingContent;
  document.getElementById('wcChars').textContent = `${total.toLocaleString()}자`;
  document.getElementById('wcProgBar').style.width = `${progress}%`;
  ws?.scrollTo(0, ws.scrollHeight);
  document.getElementById('stopBtn').style.display = '';
});
socket.on('claude:continuing', ({ count, chars }) => { addLog(`이어쓰기 ${count}회 (${chars.toLocaleString()}자)`, 'warn'); });
socket.on('claude:done', ({ chapterId, chars, sufficient }) => {
  document.getElementById('stopBtn').style.display = 'none';
  document.getElementById('saveContentBtn').style.display = '';
  addLog(`집필 완료 — ${chars.toLocaleString()}자 ${sufficient ? '✅' : '⚠️ 분량 부족'}`, sufficient ? 'success' : 'warn');
  showToast(`${chars.toLocaleString()}자 집필 완료`, 'success');
});
socket.on('claude:error', ({ message }) => { addLog(`Claude 오류: ${message}`, 'error'); showToast(message, 'error'); document.getElementById('stopBtn').style.display = 'none'; });

socket.on('chapter:done', ({ id, title, chars, totalWritten }) => {
  const ch = state.chapters.find(c => c.id === id);
  if (ch) { ch.status = 'done'; ch.writtenChars = chars; }
  state.totalWritten = totalWritten;
  renderTOC(); updateStats(); renderStory();
  addLog(`✅ ${title} — ${chars.toLocaleString()}자 Google Docs 자동 저장 완료`, 'success');
  showToast(`💾 ${chars.toLocaleString()}자 자동 저장됨`, 'success');
  document.getElementById('saveContentBtn').style.display = 'none';
  document.getElementById('streamSaveBar') && (document.getElementById('streamSaveBar').style.display = 'none');
});

socket.on('outline:generated', ({ chapters, bookTitle }) => {
  state.chapters = chapters;
  if (bookTitle) { state.bookTitle = bookTitle; syncTitle(); }
  renderTOC(); updateStats(); renderStory();
  document.getElementById('tocStats').style.display = 'flex';
  document.getElementById('tocProgress').style.display = '';
  hideLoading();
  isAnalyzing = false;
  setAnalyzeBtn(false);
  addLog(`✅ 목차 생성 완료 — ${chapters.length}개 챕터`, 'success');
});
socket.on('outline:updated', ({ chapters }) => { state.chapters = chapters; renderTOC(); updateStats(); });
socket.on('outline:reset',   () => { state.chapters = []; state.totalWritten = 0; renderTOC(); updateStats(); showToast('목차 초기화됨', 'info'); });

socket.on('book:title-updated', ({ title }) => { state.bookTitle = title; syncTitle(); addLog(`📝 도서 제목: ${title}`, 'success'); });

socket.on('auto:start',   () => { setAutoUI('running'); });
socket.on('auto:paused',  () => { setAutoUI('paused');  addLog('일시정지', 'warn'); });
socket.on('auto:resumed', () => { setAutoUI('running'); });
socket.on('auto:stopped', () => { setAutoUI('stopped'); addLog('중지됨', 'warn'); });
socket.on('auto:chapter-start', ({ id, title, attempt }) => {
  const ch = state.chapters.find(c => c.id === id);
  if (ch) ch.status = 'writing';
  renderTOC();
  document.getElementById('autoStatus').textContent = `✍️ ${title}${attempt > 0 ? ` (재시도 ${attempt})` : ''}`;
  document.getElementById('autoStatus').className = 'auto-status running';
  addLog(`집필 시작: ${title}`, 'info');
});
socket.on('auto:chapter-done', ({ id, title, chars, totalWritten, done, total, remainingSeconds, progress }) => {
  const ch = state.chapters.find(c => c.id === id);
  if (ch) { ch.status = 'done'; ch.writtenChars = chars; }
  state.totalWritten = totalWritten;
  renderTOC(); updateStats();
  document.getElementById('autoStatus').textContent = `✅ ${title}`;
  if (remainingSeconds > 0) {
    const m = Math.floor(remainingSeconds / 60), s = remainingSeconds % 60;
    document.getElementById('etaLabel').textContent = `예상 잔여: ${m}분 ${s}초`;
  }
  addLog(`✅ ${title} — ${chars.toLocaleString()}자 (${done}/${total})`, 'success');
});
socket.on('auto:retry',   ({ id, attempt, error }) => { addLog(`재시도 ${attempt}/3: ${error || '분량 부족'}`, 'warn'); });
socket.on('auto:chapter-error', ({ title, error }) => { addLog(`❌ ${title}: ${error}`, 'error'); });
socket.on('auto:complete', ({ total, done }) => {
  setAutoUI('stopped');
  addLog(`🎉 집필 완료! ${total.toLocaleString()}자 / ${done}챕터`, 'success');
  showToast('🎉 도서 집필 완료!', 'success');
  document.getElementById('autoStatus').textContent = '🎉 집필 완료!';
  document.getElementById('etaLabel').textContent = '';
});

socket.on('gdocs:ready', ({ docId, url, reused }) => {
  state.docUrl = url;
  setBadge('docbadge', `📄 ${reused ? '기존' : '새'} 문서 연결됨`, 'ok');
  addLog(`Google Docs ${reused ? '연결' : '생성'}: ${docId.substring(0, 16)}...`, 'gdocs');
});
socket.on('gdocs:target-set', ({ docId }) => {
  setBadge('docbadge', '📌 저장 위치 지정됨', 'active');
  addLog(`저장 위치 지정: ${docId.substring(0, 16)}...`, 'gdocs');
});
socket.on('gdocs:chapter-saved', ({ title, chars }) => { addLog(`💾 저장: ${title} (${chars.toLocaleString()}자)`, 'gdocs'); });
socket.on('gdocs:error', ({ message }) => { addLog(`Google Docs 오류: ${message}`, 'error'); });

// ════════════════════════════════════════════════════
// API 초기화
// ════════════════════════════════════════════════════

async function initGemini() {
  const key   = document.getElementById('geminiKey').value.trim();
  const model = document.getElementById('geminiModel').value;
  if (!key) { showToast('Gemini API 키를 입력하세요', 'warn'); return; }
  showLoading(`Gemini ${model} 연결 중...`);
  const r = await post('/api/gemini/init', { apiKey: key, model });
  hideLoading();
  if (r.success) {
    localStorage.setItem('geminiKey', key);
    localStorage.setItem('geminiModel', model);
    setBadge('geminibadge', `Gemini ✅`, 'ok');
    showToast(`${r.model} 연결됨`, 'success');
  } else {
    showToast(`연결 실패: ${r.message}`, 'error');
    addLog(`Gemini 오류: ${r.message}`, 'error');
  }
}

async function loadGeminiModels(keyOverride) {
  const key = keyOverride || document.getElementById('geminiKey').value.trim();
  if (!key || key.length < 10) return;

  // 임시로 서버에 키 전달 후 모델 목록 조회
  await post('/api/gemini/init', { apiKey: key, model: document.getElementById('geminiModel').value });
  const r = await fetch('/api/gemini/models').then(r => r.json());
  if (!r.models || !r.models.length) return;

  const sel = document.getElementById('geminiModel');
  const cur = sel.value;
  sel.innerHTML = r.models.map(m =>
    `<option value="${m.id}" ${m.id === cur ? 'selected' : ''}>${m.id}${m.displayName ? ' — ' + m.displayName : ''}</option>`
  ).join('');
  showToast(`${r.models.length}개 모델 로드됨`, 'success');
  addLog(`사용 가능 Gemini 모델: ${r.models.map(m => m.id).join(', ')}`, 'info');
}

async function initClaude() {
  const key   = document.getElementById('claudeKey').value.trim();
  const model = document.getElementById('claudeModel').value;
  if (!key) { showToast('Claude API 키를 입력하세요', 'warn'); return; }
  const r = await post('/api/claude/init', { apiKey: key, model });
  if (r.success) { localStorage.setItem('claudeKey', key); localStorage.setItem('claudeModel', model); setBadge('claudebadge', `Claude ✅`, 'ok'); showToast(`Claude ${model} 연결됨`, 'success'); }
  else showToast(r.message, 'error');
}

// ════════════════════════════════════════════════════
// 기획서 분석
// ════════════════════════════════════════════════════

async function analyzeFromUrl() {
  if (isAnalyzing) { showToast('분석 중입니다. 잠시 기다려주세요 (최대 2분)', 'warn'); return; }
  const url = document.getElementById('planningUrl').value.trim();
  if (!url) { showToast('Google Docs URL을 입력하세요', 'warn'); return; }
  const sv = await fetch('/api/status').then(r => r.json()).catch(() => ({}));
  if (!sv.gemini && !sv.claude) {
    showToast('Claude API 키를 입력하고 "연결" 버튼을 클릭하세요', 'error');
    addLog('❌ Claude 미연결 — API 키를 연결해야 합니다', 'error');
    return;
  }
  state.claudeReady = sv.claude;
  state.geminiReady = sv.gemini;

  isAnalyzing = true;
  setAnalyzeBtn(true);
  showLoading('📖 기획서 읽는 중... (Claude 사용 시 최대 2분 소요)');
  addLog('기획서 분석 시작 — 완료까지 기다려주세요', 'info');

  try {
    const r = await post('/api/outline/from-url', {
      docUrl: url,
      totalTarget: parseInt(document.getElementById('totalTarget').value),
    });
    if (!r.success) { hideLoading(); showToast(r.message, 'error'); addLog(`분석 실패: ${r.message}`, 'error'); }
  } catch(e) {
    hideLoading(); showToast('네트워크 오류', 'error');
  } finally {
    isAnalyzing = false;
    setAnalyzeBtn(false);
  }
}

async function analyzeFromFile() {
  if (isAnalyzing) { showToast('이미 분석 중입니다 (최대 2분 소요)', 'warn'); return; }
  if (!uploadedFile?.text) { showToast('파일을 먼저 업로드하고 ✅ 표시를 확인하세요', 'warn'); return; }

  // 서버 실시간 상태 확인 (캐시 무시)
  const sv = await fetch('/api/status').then(r => r.json()).catch(() => ({}));
  if (!sv.gemini && !sv.claude) {
    showToast('Claude API 키를 입력하고 "연결" 버튼을 클릭하세요', 'error');
    addLog('❌ Claude 미연결 — API 키를 연결해야 합니다', 'error');
    return;
  }
  state.claudeReady = sv.claude;
  state.geminiReady = sv.gemini;

  isAnalyzing = true;
  setAnalyzeBtn(true);
  showLoading('📄 파일 분석 중... (Claude 사용 시 최대 2분 소요)');
  addLog('파일 분석 시작 — 완료까지 기다려주세요', 'info');

  try {
    const r = await post('/api/outline/from-text', {
      text: uploadedFile.text,
      bookTitle: uploadedFile.filename?.replace(/\.[^/.]+$/, '') || '',
      totalTarget: parseInt(document.getElementById('totalTarget').value),
    });
    if (!r.success) { hideLoading(); showToast(r.message, 'error'); addLog(`분석 실패: ${r.message}`, 'error'); }
  } catch(e) {
    hideLoading(); showToast('네트워크 오류', 'error');
  } finally {
    isAnalyzing = false;
    setAnalyzeBtn(false);
  }
}

function setAnalyzeBtn(loading) {
  const btn  = document.getElementById('analyzeBtn');
  const fBtn = document.getElementById('analyzeFileBtn');
  const label = state.gensparkConnected ? '🤖 Genspark' : '✦ AI';
  if (btn)  { btn.disabled  = loading; btn.textContent  = loading ? '⏳ 분석 중...' : `${label} URL 기획서 분석`; }
  if (fBtn) { fBtn.disabled = loading; fBtn.textContent = loading ? '⏳ 분석 중...' : `${label} 파일 기획서 분석`; }
}

function updateAnalyzeBtnLabel(gsConnected) {
  if (!isAnalyzing) setAnalyzeBtn(false);
  const label = gsConnected ? '🤖 Genspark' : '✦ AI';
  const hint  = document.getElementById('analyzeHint');
  if (hint) hint.textContent = gsConnected ? 'Genspark(Claude Opus 4.6) 사용 중' : 'Gemini/Claude 사용';
  // 분석 버튼 스타일 변경
  const btns = [document.getElementById('analyzeBtn'), document.getElementById('analyzeFileBtn')];
  btns.forEach(b => {
    if (!b) return;
    if (gsConnected) {
      b.style.background = 'linear-gradient(135deg,#1a4a2a,#2d7a3a)';
      b.style.border = '1px solid rgba(76,175,122,0.6)';
      b.style.color = '#fff';
    } else {
      b.style.background = '';
      b.style.border = '';
      b.style.color = '';
    }
  });
}

// ════════════════════════════════════════════════════
// 파일 업로드
// ════════════════════════════════════════════════════

function onDragOver(e)  { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onDrop(e)      { e.preventDefault(); e.currentTarget.classList.remove('drag-over'); processFile(e.dataTransfer.files[0]); }
function onFileSelect(e){ processFile(e.target.files[0]); e.target.value = ''; }

async function processFile(file) {
  if (!file) return;
  const fl = document.getElementById('fileList');
  fl.innerHTML = `<div class="file-item"><span>📄</span><span class="file-item-name">${esc(file.name)}</span><span class="file-item-status">처리중...</span></div>`;

  const fd = new FormData(); fd.append('file', file);
  const r = await fetch('/api/upload', { method: 'POST', body: fd }).then(r => r.json());

  if (r.success) {
    uploadedFile = r;
    fl.innerHTML = `<div class="file-item"><span>📄</span><span class="file-item-name">${esc(file.name)}</span><span class="file-item-status done">✅ ${r.chars.toLocaleString()}자</span></div>`;
    document.getElementById('analyzeFileBtn').style.display = '';
    showToast(`${file.name} 파싱 완료 (${r.chars.toLocaleString()}자)`, 'success');
    // 기획서 탭에 내용 표시
    showPlanningDoc(r.text, file.name);
  } else {
    fl.innerHTML = `<div class="file-item"><span>📄</span><span class="file-item-name">${esc(file.name)}</span><span class="file-item-status error">❌ ${r.message}</span></div>`;
    showToast(r.message, 'error');
  }
}

// ════════════════════════════════════════════════════
// Google Drive 파일 피커
// ════════════════════════════════════════════════════

function openDrivePicker(mode) {
  drivePickerMode  = mode;
  driveSelectedFile = null;
  document.getElementById('drivePickerTitle').textContent = mode === 'planning' ? '📂 기획서 파일 선택' : '📂 저장할 파일 선택';
  document.getElementById('drivePickerConfirm').disabled = true;
  document.getElementById('driveFileList').innerHTML = '<div style="text-align:center;color:var(--dim);padding:20px;font-size:11px">검색하거나 "최근 파일"을 클릭하세요</div>';
  document.getElementById('driveSearch').value = '';
  document.getElementById('drivePicker').style.display = 'flex';
  loadRecentFiles();
}
function closeDrivePicker() { document.getElementById('drivePicker').style.display = 'none'; }

async function loadRecentFiles() {
  document.getElementById('driveFileList').innerHTML = '<div style="text-align:center;color:var(--dim);padding:20px">로딩 중...</div>';
  const r = await fetch('/api/drive/recent').then(r => r.json());
  renderDriveFiles(r.files || []);
}

async function searchDrive() {
  const q = document.getElementById('driveSearch').value.trim();
  const query = q ? `name contains '${q}'` : 'mimeType="application/vnd.google-apps.document"';
  const r = await fetch(`/api/drive/search?q=${encodeURIComponent(query)}`).then(r => r.json());
  renderDriveFiles(r.files || []);
}

function renderDriveFiles(files) {
  const list = document.getElementById('driveFileList');
  if (!files.length) { list.innerHTML = '<div style="text-align:center;color:var(--dim);padding:20px;font-size:11px">파일이 없습니다</div>'; return; }

  const ICONS = { 'application/vnd.google-apps.document': '📄', 'application/vnd.google-apps.spreadsheet': '📊', 'application/pdf': '📕' };
  list.innerHTML = files.map(f => `
    <div class="drive-file-item" onclick="selectDriveFile(this,'${f.id}','${esc(f.name)}','${esc(f.webViewLink||'')}')">
      <div class="drive-file-icon">${ICONS[f.mimeType] || '📄'}</div>
      <div class="drive-file-info">
        <div class="drive-file-name">${esc(f.name)}</div>
        <div class="drive-file-meta">${f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString('ko-KR') : ''}</div>
      </div>
    </div>
  `).join('');
}

function selectDriveFile(el, id, name, url) {
  document.querySelectorAll('.drive-file-item').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
  driveSelectedFile = { id, name, url };
  document.getElementById('drivePickerConfirm').disabled = false;
}

function confirmDrivePick() {
  if (!driveSelectedFile) return;
  if (drivePickerMode === 'planning') {
    const docUrl = driveSelectedFile.url || `https://docs.google.com/document/d/${driveSelectedFile.id}/edit`;
    document.getElementById('planningUrl').value = docUrl;
    showToast(`기획서 선택: ${driveSelectedFile.name}`, 'success');
  } else {
    const docUrl = driveSelectedFile.url || `https://docs.google.com/document/d/${driveSelectedFile.id}/edit`;
    document.getElementById('targetDocUrl').value = docUrl;
    showToast(`저장 파일 선택: ${driveSelectedFile.name}`, 'success');
  }
  closeDrivePicker();
}

// ════════════════════════════════════════════════════
// Google Docs 설정
// ════════════════════════════════════════════════════

async function setTargetDoc() {
  const url = document.getElementById('targetDocUrl').value.trim();
  if (!url) { showToast('URL을 입력하세요', 'warn'); return; }
  const r = await post('/api/gdocs/set-target', { docUrl: url });
  if (r.success) {
    setBadge('docbadge', '📌 저장 위치 지정됨', 'active');
    const status = document.getElementById('docTargetStatus');
    status.textContent = `✅ 지정됨: ${r.docId.substring(0, 16)}...`;
    status.className = 'badge ok';
    showToast('저장 위치 지정 완료', 'success');
  } else showToast(r.message, 'error');
}

async function createNewDoc() {
  const r = await post('/api/gdocs/create');
  if (r.success) {
    state.docUrl = r.docUrl;
    setBadge('docbadge', '📄 새 문서 생성됨', 'ok');
    showToast('Google Docs 문서 생성됨', 'success');
  } else showToast(r.message, 'error');
}

// ════════════════════════════════════════════════════
// 도서 제목 편집
// ════════════════════════════════════════════════════

function startEditTitle() {
  document.getElementById('bookTitle').style.display = 'none';
  const ed = document.getElementById('titleEditor');
  ed.style.display = 'flex';
  const inp = document.getElementById('titleInput');
  inp.value = state.bookTitle || '';
  inp.focus();
  inp.onkeydown = e => { if (e.key === 'Enter') confirmTitle(); if (e.key === 'Escape') cancelTitle(); };
}
function cancelTitle() {
  document.getElementById('bookTitle').style.display = '';
  document.getElementById('titleEditor').style.display = 'none';
}
async function confirmTitle() {
  const title = document.getElementById('titleInput').value.trim();
  if (!title) { cancelTitle(); return; }
  cancelTitle();
  const r = await post('/api/book/title', { title });
  if (r.success) { state.bookTitle = title; syncTitle(); showToast(`📝 제목: ${title}`, 'success'); }
  else showToast('제목 변경 실패', 'error');
}

// ════════════════════════════════════════════════════
// 목차 렌더링
// ════════════════════════════════════════════════════

function renderTOC() {
  const body   = document.getElementById('tocBody');
  if (!body) return;
  const search = (document.getElementById('tocSearch')?.value || '').toLowerCase();
  const filter = document.getElementById('tocFilter')?.value || '';

  // 통계 업데이트
  const doneCnt    = state.chapters.filter(c => c.status === 'done').length;
  const writingCnt = state.chapters.filter(c => c.status === 'writing').length;
  const pendingCnt = state.chapters.filter(c => c.status !== 'done' && c.status !== 'writing').length;
  document.getElementById('tsDone').textContent    = doneCnt;
  document.getElementById('tsWriting').textContent = writingCnt;
  document.getElementById('tsPending').textContent = pendingCnt;
  document.getElementById('tsTotal').textContent   = state.chapters.length;

  if (!state.chapters.length) {
    body.innerHTML = `<div class="toc-empty-msg"><div style="font-size:32px;margin-bottom:8px">📖</div><div style="font-weight:700;margin-bottom:4px">목차 없음</div><div style="color:var(--dim);font-size:11px">기획서를 분석하면 목차가 표시됩니다</div></div>`;
    return;
  }

  // 필터링
  const chs = state.chapters.filter(c =>
    (!search || c.title.toLowerCase().includes(search) || (c.summary||'').toLowerCase().includes(search)) &&
    (!filter || c.type === filter)
  );

  if (!chs.length) {
    body.innerHTML = `<div class="toc-empty-msg"><div style="color:var(--dim)">검색 결과 없음</div></div>`;
    return;
  }

  // PART별 그룹핑
  const parts = {};
  chs.forEach(ch => { const k = ch.partNum ?? 0; if (!parts[k]) parts[k] = []; parts[k].push(ch); });

  const pNames = { 0:'프롤로그', 1:'PART 1', 2:'PART 2', 3:'PART 3', 4:'PART 4', 5:'에필로그' };
  const siMap  = { done:'✅', writing:'✍️', error:'❌', pending:'○' };

  let html = '';
  for (const [pn, items] of Object.entries(parts).sort((a,b) => +a[0]-+b[0])) {
    const p       = +pn;
    const donePart = items.filter(c=>c.status==='done').length;
    const totalTarget = items.reduce((s,c) => s+(c.targetChars||0), 0);
    const totalWritten = items.reduce((s,c) => s+(c.writtenChars||0), 0);
    const pct = totalTarget ? Math.round(totalWritten/totalTarget*100) : 0;
    const partSel = items.length > 0 && items.every(c => selectedIds.has(c.id));
    const partInd = !partSel && items.some(c => selectedIds.has(c.id));

    html += `<div class="toc-part-hdr">
      <input type="checkbox" ${partSel?'checked':''} ${partInd?'data-ind="true"':''}
             onclick="togglePartSel(${p})">
      <span class="toc-part-name">${pNames[p]||`PART ${p}`}</span>
      <span class="toc-part-stats">${donePart}/${items.length} · ${(totalTarget/10000).toFixed(1)}만자 · ${pct}%</span>
    </div>`;

    for (const ch of items) {
      const active  = ch.id === state.currentChapterId;
      const sel     = selectedIds.has(ch.id);
      const si      = siMap[ch.status||'pending'];
      const pctCh   = ch.targetChars ? Math.min(100,Math.round((ch.writtenChars||0)/ch.targetChars*100)) : 0;
      const writtenK = ch.writtenChars ? `${(ch.writtenChars/1000).toFixed(1)}k` : '0';
      const targetK  = ch.targetChars  ? `${(ch.targetChars /1000).toFixed(0)}k` : '';

      html += `<div class="toc-ch ${ch.status||'pending'} ${active?'active':''} ${sel?'selected':''}"
               data-id="${ch.id}" onclick="handleTocClick(event,${ch.id})">
        <input type="checkbox" ${sel?'checked':''} onclick="event.stopPropagation();toggleSel(${ch.id})">
        <div class="toc-ch-main">
          <div class="toc-ch-top">
            <span class="toc-ch-si">${si}</span>
            <span class="toc-ch-num">CH.${ch.num}</span>
            <span class="toc-ch-title" title="${esc(ch.title)}">${esc(ch.title)}</span>
          </div>
          <div class="toc-ch-meta">
            <span class="toc-ch-type ${esc(ch.type)}">${esc(ch.type)}</span>
            <span class="toc-ch-chars">${writtenK} / ${targetK}자${pctCh>0?` (${pctCh}%)`:''}</span>
          </div>
          ${pctCh>0?`<div class="toc-ch-bar"><div class="toc-ch-bar-fill" style="width:${pctCh}%"></div></div>`:''}
        </div>
        <button class="toc-ch-btn" onclick="event.stopPropagation();writeChapter(${ch.id})">${ch.status==='done'?'🔄':'▶'}</button>
      </div>`;
    }
  }

  body.innerHTML = html;

  // indeterminate 적용
  setTimeout(() => {
    body.querySelectorAll('[data-ind="true"]').forEach(el => { el.indeterminate = true; });
  }, 0);
}

function handleTocClick(e, id) {
  if (e.target.type === 'checkbox' || e.target.classList.contains('toc-ch-btn')) return;
  selectChapter(id);
}

function clearTocHistory() {
  fetch('/api/gemini/clear-toc', { method:'POST' });
  const msgs = document.getElementById('tocChatMsgs');
  if (msgs) msgs.innerHTML = '<div class="toc-ai-msg ai">대화가 초기화됐습니다</div>';
}

function selectChapter(id) {
  state.currentChapterId = id;
  renderTOC();
}

// ════════════════════════════════════════════════════
// P2 탭 전환 (전체목차 / 스토리텔링 / 기획서)
// ════════════════════════════════════════════════════
function switchP2Tab(tab) {
  ['toc','story','plan'].forEach(t => {
    const btn  = document.getElementById(`p2tab-${t}`);
    const pane = document.getElementById(`p2pane-${t}`);
    if (btn)  btn.classList.toggle('active', t === tab);
    if (pane) pane.style.display = t === tab ? 'flex' : 'none';
  });
}

// ── 전체 스토리텔링 렌더링 ───────────────────────────
function renderStory() {
  const body = document.getElementById('storyBody');
  if (!body || !state.chapters.length) return;

  const pNames = { 0:'프롤로그', 1:'PART 1', 2:'PART 2', 3:'PART 3', 4:'PART 4', 5:'에필로그' };
  const siMap  = { done:'✅', writing:'✍️', error:'❌', pending:'○' };
  const parts  = {};
  state.chapters.forEach(ch => { const k = ch.partNum??0; if(!parts[k]) parts[k]=[]; parts[k].push(ch); });

  let html = '';
  for (const [pn, chs] of Object.entries(parts).sort((a,b)=>+a[0]-+b[0])) {
    const totalK = (chs.reduce((s,c)=>s+(c.targetChars||0),0)/10000).toFixed(1);
    const done   = chs.filter(c=>c.status==='done').length;
    html += `<div class="story-part">
      <div class="story-part-title">
        <span>${pNames[+pn]||`PART ${pn}`}</span>
        <span style="color:var(--dim)">${done}/${chs.length} 완료 · ${totalK}만자</span>
      </div>`;
    chs.forEach(ch => {
      const pct = ch.targetChars ? Math.min(100,Math.round((ch.writtenChars||0)/ch.targetChars*100)) : 0;
      html += `<div class="story-ch ${ch.status||'pending'}">
        <div class="story-ch-header">
          <span class="story-ch-si">${siMap[ch.status||'pending']}</span>
          <span class="story-ch-num">CH.${ch.num}</span>
          <span class="story-ch-title">${esc(ch.title)}</span>
          <span class="story-ch-type">${esc(ch.type)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--dim);margin-bottom:4px">
          <span>목표 ${(ch.targetChars/1000).toFixed(0)}k자</span>
          <span>${ch.writtenChars?(ch.writtenChars/1000).toFixed(1)+'k작성':'미집필'}${pct>0?` · ${pct}%`:''}</span>
        </div>
        ${pct>0?`<div style="height:3px;background:var(--bg4);border-radius:2px;margin-bottom:5px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--green);border-radius:2px"></div></div>`:''}
        ${ch.summary?`<div class="story-ch-summary">📌 ${esc(ch.summary)}</div>`:''}
        ${ch.chapterSummary?`<div class="story-ch-done-summary">✅ ${esc(ch.chapterSummary.substring(0,150))}${ch.chapterSummary.length>150?'...':''}</div>`:''}
      </div>`;
    });
    html += '</div>';
  }
  body.innerHTML = html;
}

async function generateStorySummary() {
  if (!state.chapters.length) { showToast('목차를 먼저 생성하세요', 'warn'); return; }
  renderStory();
  switchP2Tab('story');
  showToast('스토리 뷰 업데이트됨', 'success');
}

// ── 기획서 표시 ─────────────────────────────────────
function showPlanningDoc(text, title = '기획서') {
  const body  = document.getElementById('planBody');
  const label = document.getElementById('planDocTitle');
  const chars = document.getElementById('planDocChars');
  if (!body) return;
  state.planningText = text;
  body.textContent   = text;
  if (label) label.textContent = title;
  if (chars) chars.textContent = `${text.length.toLocaleString()}자`;
}

// ── 다중 선택 ────────────────────────────────────────
function toggleSel(id) {
  selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id);
  updateSelBar(); renderTOC();
}

function toggleSelAll(checked) {
  if (checked) state.chapters.forEach(c => selectedIds.add(c.id));
  else selectedIds.clear();
  updateSelBar(); renderTOC();
}

function togglePartSel(partNum) {
  const chs = state.chapters.filter(c => c.partNum === partNum);
  const allSel = chs.every(c => selectedIds.has(c.id));
  chs.forEach(c => allSel ? selectedIds.delete(c.id) : selectedIds.add(c.id));
  updateSelBar(); renderTOC();
}

function selectPending() {
  state.chapters.filter(c => c.status !== 'done').forEach(c => selectedIds.add(c.id));
  updateSelBar(); renderTOC();
}

function invertSel() {
  state.chapters.forEach(c => selectedIds.has(c.id) ? selectedIds.delete(c.id) : selectedIds.add(c.id));
  updateSelBar(); renderTOC();
}

function clearSel() {
  selectedIds.clear();
  const cb = document.getElementById('selAll');
  if (cb) cb.checked = false;
  updateSelBar(); renderTOC();
}

function updateSelBar() {
  const bar = document.getElementById('selBar');
  if (!bar) return;
  bar.style.display = selectedIds.size ? 'flex' : 'none';
  const cnt = document.getElementById('selCount');
  if (cnt) cnt.textContent = selectedIds.size;
  // 전체선택 체크박스 상태 동기화
  const cb = document.getElementById('selAll');
  if (cb && state.chapters.length > 0) {
    cb.indeterminate = selectedIds.size > 0 && selectedIds.size < state.chapters.length;
    cb.checked = selectedIds.size === state.chapters.length;
  }
}

async function writeSelected() {
  if (!selectedIds.size) { showToast('챕터를 선택하세요', 'warn'); return; }
  const engine = writeEngine;
  if (engine === 'genspark' && !state.gensparkConnected) { showToast('먼저 Genspark를 연결하세요', 'warn'); openGsModal(); return; }
  if (engine === 'claude' && !state.claudeReady) { showToast('Claude API 키를 먼저 설정하세요', 'warn'); return; }

  const ids = [...selectedIds].sort((a, b) => a - b);
  showToast(`${ids.length}개 챕터 순서대로 집필 시작`, 'success');
  clearSel();

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const ch = state.chapters.find(c => c.id === id);
    if (!ch) continue;

    addLog(`▶ [${i+1}/${ids.length}] ${ch.title} 집필 시작`, 'info');
    // writeChapter 내부 로직 재사용 (스트림 탭 전환 포함)
    await writeChapter(id);
    // writeChapter가 이미 전송까지 처리하므로 별도 전송 불필요

    // 해당 챕터 완료 대기 (ID 일치 확인)
    await new Promise(resolve => {
      const onDone = (data) => {
        if (data.id === id) {
          socket.off('chapter:done', onDone);
          socket.off('claude:done', onDone);
          resolve();
        }
      };
      const onClaudeDone = () => {
        socket.off('chapter:done', onDone);
        socket.off('claude:done', onClaudeDone);
        resolve();
      };
      socket.on('chapter:done', onDone);
      socket.on('claude:done', onClaudeDone);
      setTimeout(() => {
        socket.off('chapter:done', onDone);
        socket.off('claude:done', onClaudeDone);
        resolve();
      }, 360000);
    });

    await new Promise(r => setTimeout(r, 1500));
  }
  showToast(`✅ 선택 ${ids.length}개 챕터 집필 완료!`, 'success');
}

async function deleteSelected() {
  if (!selectedIds.size) return;
  if (!confirm(`선택된 ${selectedIds.size}개 챕터를 삭제하시겠습니까?`)) return;
  const ids = [...selectedIds];
  await fetch('/api/chapters/batch', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  state.chapters = state.chapters.filter(c => !ids.includes(c.id));
  selectedIds.clear(); updateSelBar(); renderTOC(); updateStats();
  showToast(`${ids.length}개 챕터 삭제됨`, 'info');
}

function confirmResetOutline() {
  if (!state.chapters.length) return;
  if (!confirm(`목차 ${state.chapters.length}개 챕터를 전체 초기화하시겠습니까?\n(집필된 내용은 Google Docs에 남습니다)`)) return;
  resetOutline();
}

async function resetOutline() {
  await post('/api/chapters/reset');
  selectedIds.clear(); updateSelBar();
}

// ════════════════════════════════════════════════════
// 집필 AI 선택
// ════════════════════════════════════════════════════

function setEngine(val) {
  writeEngine = val;
  const statusEl = document.getElementById('engineStatus');
  if (val === 'genspark') {
    statusEl.textContent = 'Genspark 선택됨 (P3 탭에서 연결)';
    statusEl.className = 'badge active';
  } else {
    statusEl.textContent = 'Claude API 선택됨';
    statusEl.className = 'badge ok';
  }
}

// ════════════════════════════════════════════════════
// Genspark 연결/제어
// ════════════════════════════════════════════════════

// ── Genspark 모달 ────────────────────────────────────
function openGsModal() {
  document.getElementById('gsModal').style.display = 'flex';
  updateGsModalBadge(state.gensparkConnected);
}
function closeGsModal() { document.getElementById('gsModal').style.display = 'none'; }

function updateGsModalBadge(connected) {
  const badge = document.getElementById('gsModalBadge');
  const conn  = document.getElementById('gsModalConnectBtn');
  const disc  = document.getElementById('gsModalDisconnBtn');
  if (!badge) return;
  if (connected) {
    badge.textContent = '🟢 연결됨'; badge.className = 'badge ok';
    if (conn) conn.style.display = 'none';
    if (disc) disc.style.display = '';
  } else {
    badge.textContent = '⚫ 미연결'; badge.className = 'badge';
    if (conn) conn.style.display = '';
    if (disc) disc.style.display = 'none';
  }
}

async function gsModalConnect() {
  const url = (document.getElementById('gsModalUrl')?.value || document.getElementById('gsUrl')?.value || '').trim();
  if (!url) { showToast('Genspark URL을 입력하세요', 'warn'); return; }
  // P3 탭 URL 입력란도 동기화
  const gsUrlEl = document.getElementById('gsUrl');
  if (gsUrlEl) gsUrlEl.value = url;
  showLoading('Genspark 브라우저 시작 중... (최대 60초)');
  const r = await post('/api/genspark/connect', { url });
  if (!r.success) { hideLoading(); showToast(r.message, 'error'); }
}

async function gsConnect() {
  const url = document.getElementById('gsUrl')?.value?.trim() || '';
  if (!url) { openGsModal(); return; }
  showLoading('Genspark 브라우저 시작 중...');
  const r = await post('/api/genspark/connect', { url });
  if (!r.success) { hideLoading(); showToast(r.message, 'error'); }
}

// ── Genspark로 목차 생성 ────────────────────────────
async function gsGenerateToc() {
  if (!state.gensparkConnected) { showToast('Genspark를 먼저 연결하세요', 'warn'); openGsModal(); return; }
  if (!uploadedFile?.text && !document.getElementById('planningUrl')?.value) {
    showToast('기획서 파일이나 URL을 먼저 입력하세요', 'warn'); return;
  }

  const text   = uploadedFile?.text || '';
  const title  = uploadedFile?.filename?.replace(/\.[^/.]+$/, '') || state.bookTitle || '';
  const target = parseInt(document.getElementById('totalTarget')?.value) || 4000000;

  if (!text && document.getElementById('planningUrl')?.value) {
    showToast('URL 기획서는 먼저 "URL 기획서 분석" 버튼을 사용하세요', 'warn'); return;
  }

  showLoading('🤖 Genspark(Claude Opus 4.6)로 목차 생성 중...\n완료까지 2~5분 소요');
  isAnalyzing = true;
  setAnalyzeBtn(true);

  try {
    const r = await post('/api/genspark/generate-toc', { text, bookTitle: title, totalTarget: target });
    hideLoading();
    if (r.success) {
      showToast(`🤖 Genspark 목차 ${r.chapters.length}개 생성 완료`, 'success');
      switchP2Tab('toc');
    } else {
      showToast(`실패: ${r.message}`, 'error');
      addLog(`Genspark 목차 실패: ${r.message}`, 'error');
    }
  } finally {
    isAnalyzing = false;
    setAnalyzeBtn(false);
  }
}

// ── Genspark로 스토리텔링 생성 ──────────────────────
async function gsGenerateStory() {
  if (!state.gensparkConnected) { showToast('Genspark를 먼저 연결하세요', 'warn'); openGsModal(); return; }
  if (!state.chapters.length) { showToast('목차를 먼저 생성하세요', 'warn'); switchP2Tab('toc'); return; }

  showLoading('🤖 Genspark로 스토리텔링 생성 중...\n완료까지 2~3분 소요');
  const r = await post('/api/genspark/generate-story');
  hideLoading();
  if (r.success) switchP2Tab('story');
  else showToast(`실패: ${r.message}`, 'error');
}

// ── Genspark로 기획서 분석 ──────────────────────────
async function gsAnalyzePlan() {
  if (!state.gensparkConnected) { showToast('Genspark를 먼저 연결하세요', 'warn'); openGsModal(); return; }
  const text = state.planningText || uploadedFile?.text;
  if (!text) { showToast('기획서 텍스트가 없습니다', 'warn'); return; }

  showLoading('🤖 Genspark로 기획서 분석 중...');
  const r = await post('/api/genspark/analyze-plan', { text });
  hideLoading();
  if (r.success) {
    showPlanningDoc(r.text + '\n\n---\n\n[원문]\n' + (state.planningText || ''), '기획서 (Genspark 분석)');
    showToast('기획서 분석 완료', 'success');
  } else {
    showToast(`실패: ${r.message}`, 'error');
  }
}

async function gsDiagnose() {
  if (!state.gensparkConnected) { showToast('먼저 Genspark를 연결하세요', 'warn'); return; }
  addLog('🔍 Genspark 입력창 진단 중...', 'info');
  const r = await fetch('/api/genspark/diagnose', { method: 'POST' }).then(r => r.json());
  showToast('진단 완료 — 로그 확인', 'info');
}

socket.on('genspark:diagnose', ({ elements }) => {
  if (!elements || elements.length === 0) {
    addLog('🔍 진단: 입력 가능한 요소 없음 — Genspark 페이지가 완전히 로드됐는지 확인하세요', 'warn');
    return;
  }
  addLog(`🔍 진단 결과 — ${elements.length}개 입력 요소 발견:`, 'info');
  elements.forEach((el, i) => {
    const vis = el.visible ? '✅' : '❌';
    addLog(`  ${i+1}. ${vis} <${el.tag}> id="${el.id}" class="${el.class}" placeholder="${el.placeholder}" 위치:${el.rect}`, 'info');
  });
});

async function gsSelectModel() {
  const model = document.getElementById('gsClaudeModel')?.value;
  if (!model) return;
  if (!state.gensparkConnected) { showToast('먼저 Genspark를 연결하세요', 'warn'); return; }

  const btn    = document.getElementById('gsModelBtn');
  const status = document.getElementById('gsModelStatus');
  if (btn) { btn.disabled = true; btn.textContent = '적용 중...'; }
  if (status) status.textContent = `"${model}" 선택 중...`;

  const r = await post('/api/genspark/select-model', { model });

  if (btn) { btn.disabled = false; btn.textContent = '모델 적용'; }
  if (r.success) {
    if (status) { status.textContent = `✅ ${model} 적용됨`; status.style.color = 'var(--green)'; }
    showToast(`Genspark 모델: ${model}`, 'success');
  } else {
    if (status) { status.textContent = `⚠️ 자동 선택 실패 — Genspark 브라우저에서 직접 선택하세요`; status.style.color = 'var(--orange)'; }
    showToast('Genspark 브라우저에서 직접 모델을 선택해주세요', 'warn');
  }
}

socket.on('genspark:model-selected', ({ model, message }) => {
  addLog(`✅ Genspark 모델: ${model}`, 'success');
  const status = document.getElementById('gsModelStatus');
  if (status) { status.textContent = `✅ ${model} 적용됨`; status.style.color = 'var(--green)'; }
});

socket.on('genspark:model-select-fail', ({ message }) => {
  addLog(`⚠️ ${message}`, 'warn');
  showToast(message, 'warn');
  const status = document.getElementById('gsModelStatus');
  if (status) { status.textContent = `⚠️ ${message}`; status.style.color = 'var(--orange)'; }
});

async function gsModalManualSave() {
  const text = document.getElementById('gsModalManual')?.value?.trim();
  if (!text) { showToast('내용을 붙여넣으세요', 'warn'); return; }
  const r = await post('/api/genspark/manual-save', { content: text, chapterId: state.currentChapterId });
  if (r.success) { document.getElementById('gsModalManual').value = ''; showToast(`${r.chars.toLocaleString()}자 저장됨`, 'success'); }
  else showToast(r.message, 'error');
}

async function gsDisconnect() {
  await post('/api/genspark/disconnect');
}

async function refreshGsScreen() {
  const r = await fetch('/api/genspark/screenshot').then(r => r.json());
  if (r.image) {
    const img = document.getElementById('gsScreenImg');
    img.src = `data:image/jpeg;base64,${r.image}`;
    img.style.display = 'block';
    document.getElementById('gsPlaceholder').style.display = 'none';
  }
}

async function gsClear() {
  await post('/api/genspark/clear');
  document.getElementById('gsTextContent').textContent = '';
  document.getElementById('gsTextLen').textContent = '0자';
  gsCurrentText = '';
}

function gsCopyText() {
  if (!gsCurrentText) return;
  navigator.clipboard.writeText(gsCurrentText).then(() => showToast('복사됨', 'success'));
}

async function gsManualSave() {
  if (!gsCurrentText || gsCurrentText.length < 50) { showToast('저장할 내용이 없습니다', 'warn'); return; }
  const r = await post('/api/genspark/manual-save', { content: gsCurrentText, chapterId: state.currentChapterId });
  if (r.success) showToast(`${r.chars.toLocaleString()}자 저장됨`, 'success');
  else showToast(r.message, 'error');
}

async function gsManualSaveText() {
  const text = document.getElementById('gsManualText').value.trim();
  if (!text) { showToast('내용을 붙여넣으세요', 'warn'); return; }
  const r = await post('/api/genspark/manual-save', { content: text, chapterId: state.currentChapterId });
  if (r.success) { document.getElementById('gsManualText').value = ''; showToast(`${r.chars.toLocaleString()}자 저장됨`, 'success'); }
  else showToast(r.message, 'error');
}

// ════════════════════════════════════════════════════
// 집필 탭 내부 패널 전환
// ════════════════════════════════════════════════════
function switchWriteTab(tab) {
  ['prompt','stream','paste'].forEach(t => {
    const btn  = document.getElementById(`wetab-${t}`);
    const pane = document.getElementById(`wpane-${t}`);
    if (btn)  btn.classList.toggle('active', t === tab);
    if (pane) pane.style.display = t === tab ? 'flex' : 'none';
  });
  // 저장 바: stream 탭에서만 표시
  const bar = document.getElementById('streamSaveBar');
  if (bar) bar.style.display = tab === 'stream' ? '' : 'none';
}

// ════════════════════════════════════════════════════
// 챕터 집필
// ════════════════════════════════════════════════════

async function writeChapter(id) {
  selectChapter(id);
  switchTab('write');
  showWritingPane(id);
  writingContent = '';

  // 스트림 탭 초기화
  const ws = document.getElementById('writingStream');
  if (ws) ws.textContent = '';
  document.getElementById('wcChars').textContent   = '0자';
  document.getElementById('wcProgBar').style.width = '0%';
  document.getElementById('stopBtn').style.display = 'none';
  document.getElementById('saveContentBtn').style.display = 'none';

  if (writeEngine === 'genspark') {
    if (!state.gensparkConnected) {
      // Genspark 미연결 → 프롬프트 복사 방식 (수동)
      showLoading('프롬프트 생성 중...');
      const pr = await fetch('/api/writing-prompt', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chapterId: id }),
      }).then(r => r.json());
      hideLoading();
      const prompt = pr.prompt || '';
      document.getElementById('writingPromptText').textContent = prompt;
      switchWriteTab('prompt');
      try {
        await navigator.clipboard.writeText(prompt);
        showToast('📋 프롬프트 복사됨 — Genspark에 붙여넣고 집필 후 [📥 결과 붙여넣기]에 저장하세요', 'success');
      } catch (_) { showToast('📋 복사 버튼을 클릭하세요', 'info'); }
      const pa = document.getElementById('pasteContentArea');
      if (pa) { pa.value = ''; updatePasteCount(''); }
      return;
    }

    // Genspark 연결됨 → 자동 전송 + 스트림 탭 표시
    switchWriteTab('stream');
    if (ws) ws.innerHTML = `<div style="color:var(--muted);padding:20px;text-align:center;animation:pulse 1.5s infinite">
      <div style="font-size:24px;margin-bottom:8px">🤖</div>
      <div>Genspark(Claude Opus 4.6)가 집필 중입니다...</div>
      <div style="font-size:10px;margin-top:6px;color:var(--dim)">완료되면 자동으로 내용이 표시됩니다</div>
    </div>`;

    const r = await post('/api/genspark/send', { chapterId: id });
    if (!r.success) {
      showToast(`전송 실패: ${r.message}`, 'error');
      if (ws) ws.textContent = '';
    } else {
      addLog(`🤖 Genspark 집필 전송 완료 — 응답 대기 중`, 'info');
    }

  } else {
    // Claude API 자동 스트리밍
    if (!state.claudeReady) { showToast('Claude API 키를 먼저 설정하세요', 'warn'); return; }
    switchWriteTab('stream');
    await post(`/api/chapters/${id}/write`);
  }
}

function showWritingPane(chapterId) {
  const ch = state.chapters.find(c => c.id === chapterId);
  if (!ch) return;
  document.getElementById('writingPlaceholder').style.display   = 'none';
  document.getElementById('writingEngineBar').style.display     = '';
  const info = document.getElementById('writingChapterInfo');
  info.style.display = '';
  document.getElementById('wciTitle').textContent  = ch.title;
  document.getElementById('wciType').textContent   = ch.type;
  document.getElementById('wciTarget').textContent = `${(ch.targetChars||0).toLocaleString()}자`;
  document.getElementById('wciPart').textContent   = ['프롤','P1','P2','P3','P4','에필'][ch.partNum] || '';
  document.getElementById('writingStream').textContent = '';
  document.getElementById('wcChars').textContent = '0자';
  document.getElementById('wcProgBar').style.width = '0%';
  document.getElementById('saveContentBtn').style.display = 'none';
}

async function copyPromptToClipboard() {
  const text = document.getElementById('writingPromptText')?.textContent;
  if (!text) { showToast('프롬프트가 없습니다', 'warn'); return; }
  try {
    await navigator.clipboard.writeText(text);
    showToast('📋 복사 완료! Genspark에 붙여넣으세요', 'success');
    // 붙여넣기 탭으로 이동 안내
    addLog('Genspark에서 집필 완료 후 [📥 결과 붙여넣기] 탭에 저장하세요', 'info');
  } catch (_) {
    showToast('복사 실패 — 직접 선택하여 복사하세요', 'warn');
  }
}

async function regenerateWritingPrompt() {
  const id = state.currentChapterId;
  if (!id) return;
  showLoading('프롬프트 재생성 중...');
  const r = await fetch('/api/writing-prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapterId: id }),
  }).then(r => r.json());
  hideLoading();
  if (r.prompt) { document.getElementById('writingPromptText').textContent = r.prompt; showToast('프롬프트 재생성됨', 'success'); }
}

function updatePasteCount(val) {
  const cnt = document.getElementById('pasteCharCount');
  if (cnt) cnt.textContent = `${val.length.toLocaleString()}자`;
}

async function savePastedContent() {
  const text = document.getElementById('pasteContentArea')?.value?.trim();
  if (!text || text.length < 50) { showToast('내용을 붙여넣으세요 (50자 이상)', 'warn'); return; }

  const id  = state.currentChapterId;
  const btn = document.getElementById('savePasteBtn');
  if (btn) { btn.disabled = true; btn.textContent = '💾 저장 중...'; }

  // 집필 스트림에도 내용 표시
  writingContent = text;
  const ws = document.getElementById('writingStream');
  if (ws) ws.textContent = text;
  document.getElementById('wcChars').textContent = `${text.length.toLocaleString()}자`;

  const r = await post('/api/gdocs/save-chapter', { chapterId: id, content: text });
  if (btn) { btn.disabled = false; btn.textContent = '💾 Google Docs 저장'; }

  if (r.success) {
    showToast(`✅ ${text.length.toLocaleString()}자 Google Docs 저장 완료`, 'success');
    addLog(`💾 ${text.length.toLocaleString()}자 Google Docs 저장 완료`, 'gdocs');
    // 챕터 완료 처리
    const ch = state.chapters.find(c => c.id === id);
    if (ch) { ch.status = 'done'; ch.writtenChars = text.length; ch.content = text; }
    state.totalWritten = state.chapters.reduce((s, c) => s + (c.writtenChars || 0), 0);
    renderTOC(); updateStats();
    // 집필 스트림 탭으로 전환해서 내용 확인
    switchWriteTab('stream');
  } else {
    showToast(`저장 실패: ${r.message}`, 'error');
  }
}

async function saveCurrentContent() {
  if (!writingContent || writingContent.length < 50) {
    showToast('저장할 내용이 없습니다', 'warn'); return;
  }
  const id = state.currentChapterId;
  const btn = document.getElementById('saveContentBtn');
  if (btn) { btn.disabled = true; btn.textContent = '💾 저장 중...'; }

  const r = await post('/api/gdocs/save-chapter', { chapterId: id, content: writingContent });

  if (btn) { btn.disabled = false; btn.textContent = '💾 저장'; }
  if (r.success) {
    showToast('✅ Google Docs 저장 완료', 'success');
    addLog(`💾 Google Docs 저장 완료 (${writingContent.length.toLocaleString()}자)`, 'gdocs');
    btn.style.display = 'none';
    // 챕터 상태 업데이트
    const ch = state.chapters.find(c => c.id === id);
    if (ch) { ch.status = 'done'; ch.writtenChars = writingContent.length; }
    renderTOC(); updateStats();
  } else {
    showToast(`저장 실패: ${r.message}`, 'error');
  }
}

function copyContent() {
  navigator.clipboard.writeText(writingContent).then(() => showToast('복사됨', 'success'));
}

async function stopWriting() {
  await post('/api/auto/stop');
  document.getElementById('stopBtn').style.display = 'none';
}

// ════════════════════════════════════════════════════
// Gemini 목차 대화
// ════════════════════════════════════════════════════

async function sendTocChat() {
  const input = document.getElementById('tocChatInput');
  const msg   = input.value.trim();
  if (!msg) return;
  input.value = '';
  if (!state.geminiReady) { showToast('Gemini API 키를 먼저 설정하세요', 'warn'); return; }
  addTocChatMsg('user', msg);
  const r = await post('/api/gemini/refine-toc', { message: msg, totalTarget: parseInt(document.getElementById('totalTarget').value) });
  if (!r.success) addTocChatMsg('model', `❌ ${r.message}`);
}

function addTocChatMsg(role, text) {
  const msgs = document.getElementById('tocChatMsgs');
  const div  = document.createElement('div');
  div.className = `tc-msg ${role}`;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

async function reviewTOC() {
  if (!state.geminiReady) { showToast('Gemini 먼저 연결하세요', 'warn'); return; }
  const r = await post('/api/gemini/review', { totalTarget: parseInt(document.getElementById('totalTarget').value) });
  if (r.success && r.review) addTocChatMsg('model', r.review);
}

// ════════════════════════════════════════════════════
// Gemini 일반 채팅
// ════════════════════════════════════════════════════

async function sendChat(msg) {
  const input = document.getElementById('chatInput');
  const text  = msg || input.value.trim();
  if (!text) return;
  if (!state.geminiReady) { showToast('Gemini API 키를 먼저 설정하세요', 'warn'); return; }

  input.value = '';
  document.getElementById('chatIntro')?.remove();
  document.getElementById('chatSend').disabled = true;

  appendChatMsg('user', text);
  showThinking();

  const r = await post('/api/gemini/chat', { message: text });
  hideThinking();
  document.getElementById('chatSend').disabled = false;
  if (r.success) appendChatMsg('model', r.response);
  else appendChatMsg('model', `❌ ${r.message}`);
}

function appendChatMsg(role, text) {
  const area = document.getElementById('chatMsgs');
  const div  = document.createElement('div');
  div.className = `chat-msg ${role}`;
  const time = new Date().toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });
  div.innerHTML = `<div class="chat-bubble">${esc(text)}</div><div class="chat-meta">${role === 'user' ? '나' : 'Gemini'} · ${time}</div>`;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
  document.getElementById('chatIntro') && (document.getElementById('chatIntro').style.display = 'none');
}

function showThinking() { document.getElementById('chatThinking').style.display = 'flex'; }
function hideThinking() { document.getElementById('chatThinking').style.display = 'none'; }

// ════════════════════════════════════════════════════
// 자동 집필
// ════════════════════════════════════════════════════

async function autoStart() {
  if (!state.claudeReady) { showToast('Claude API 키를 먼저 설정하세요', 'warn'); return; }
  if (!state.chapters.length) { showToast('목차를 먼저 생성하세요', 'warn'); return; }
  const r = await post('/api/auto/start');
  if (!r.success) showToast(r.message, 'error');
}
async function autoPause()  { await post('/api/auto/pause');  }
async function autoResume() { await post('/api/auto/resume'); }
async function autoStop()   { await post('/api/auto/stop');   }

function setAutoUI(state) {
  const start  = document.getElementById('autoStartBtn');
  const pause  = document.getElementById('autoPauseBtn');
  const resume = document.getElementById('autoResumeBtn');
  const stop   = document.getElementById('autoStopBtn');
  const status = document.getElementById('autoStatus');

  start.style.display  = state === 'stopped' ? '' : 'none';
  pause.style.display  = state === 'running' ? '' : 'none';
  resume.style.display = state === 'paused'  ? '' : 'none';
  stop.style.display   = state !== 'stopped' ? '' : 'none';

  if (state === 'stopped') { status.textContent = '⏸️ 대기중'; status.className = 'auto-status'; }
  if (state === 'paused')  { status.textContent = '⏸️ 일시정지'; status.className = 'auto-status'; }
}

// ════════════════════════════════════════════════════
// 탭 전환
// ════════════════════════════════════════════════════

function switchTab(tab) {
  ['write','genspark','chat'].forEach(t => {
    const tabEl  = document.getElementById(`tab-${t}`);
    const paneEl = document.getElementById(`pane-${t}`);
    if (tabEl)  tabEl.classList.toggle('active', t === tab);
    if (paneEl) paneEl.style.display = t === tab ? 'flex' : 'none';
  });
}

// ════════════════════════════════════════════════════
// 통계 & UI 갱신
// ════════════════════════════════════════════════════

function syncTitle() {
  const el = document.getElementById('bookTitle');
  if (!el) return;
  if (state.bookTitle && state.bookTitle !== '도서') {
    el.textContent = state.bookTitle;
    el.style.color = 'var(--text)';
  } else {
    el.textContent = '도서 제목을 입력하세요 (클릭)';
    el.style.color = 'var(--dim)';
  }
}

function renderAll() {
  renderTOC(); updateStats();
  updateStatusBadge(state.status);
  syncTitle();
  if (state.geminiReady) setBadge('geminibadge', 'Gemini ✅', 'ok');
  if (state.claudeReady) setBadge('claudebadge', 'Claude ✅', 'ok');
  if (state.docUrl) setBadge('docbadge', '📄 문서 연결됨', 'ok');
}

function updateStats() {
  const written = state.totalWritten || state.chapters.reduce((s,c) => s + (c.writtenChars||0), 0);
  const target  = parseInt(document.getElementById('totalTarget')?.value) || 4000000;
  const pct     = Math.min(100, written / target * 100);

  // P2 분량 진행바
  const tocW = document.getElementById('tocWrittenChars');
  const tocT = document.getElementById('tocTargetChars');
  const tocB = document.getElementById('tocProgressBar');
  if (tocW) tocW.textContent = fmt(written) + '자';
  if (tocT) tocT.textContent = `/ ${fmt(target)}자`;
  if (tocB) tocB.style.width = `${pct}%`;
  const done    = state.chapters.filter(c => c.status === 'done').length;
  const pending = state.chapters.filter(c => c.status === 'pending' || !c.status).length;

  document.getElementById('mainProg').style.width     = `${pct}%`;
  document.getElementById('progText').textContent     = `${fmt(written)} / ${fmt(target)}자`;
  document.getElementById('ringPct').textContent      = `${pct.toFixed(0)}%`;
  document.getElementById('ringFill').style.strokeDashoffset = 326.7 - (pct / 100) * 326.7;
  document.getElementById('svWritten').textContent    = fmt(written);
  document.getElementById('svTarget').textContent     = fmt(target);
  document.getElementById('svDone').textContent       = done;
  document.getElementById('svRemain').textContent     = pending;
}

function updateStatusBadge(s) {
  const labels = { idle:'● 대기중', analyzing:'⟳ 분석중', ready:'● 준비됨', writing:'✍️ 집필중', error:'❌ 오류' };
  const el = document.getElementById('statusbadge');
  el.textContent = labels[s] || s;
  el.className = `badge ${s === 'writing' ? 'active' : s === 'error' ? 'err' : ''}`;
}

function setBadge(id, text, cls) {
  const el = document.getElementById(id);
  if (el) { el.textContent = text; el.className = `badge ${cls}`; }
}

// ════════════════════════════════════════════════════
// 유틸
// ════════════════════════════════════════════════════

function fmt(n) {
  if (n >= 1000000) return `${(n/1000000).toFixed(1)}M`;
  if (n >= 1000)    return `${(n/1000).toFixed(0)}k`;
  return String(n);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function post(url, data = {}, method = 'POST') {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method !== 'GET' ? JSON.stringify(data) : undefined,
  });
  return r.json();
}

function addLog(msg, type = 'info') {
  const box = document.getElementById('logBox');
  const t   = new Date().toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const el  = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `[${t}] ${msg}`;
  box.insertBefore(el, box.firstChild);
  while (box.children.length > 50) box.removeChild(box.lastChild);
}

function clearLog() { document.getElementById('logBox').innerHTML = ''; }

function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function showLoading(msg = '처리 중...') {
  document.getElementById('loadingText').textContent = msg;
  document.getElementById('loadingOverlay').style.display = 'flex';
}
function hideLoading() { document.getElementById('loadingOverlay').style.display = 'none'; }

// ════════════════════════════════════════════════════
// 패널 리사이저 (드래그로 너비 조절)
// ════════════════════════════════════════════════════
(function initResizers() {
  // fixedPanel: 너비를 직접 조정할 패널 (flex:1 패널은 건드리지 않음)
  // p3는 flex:1이므로 절대 width를 고정하지 않음
  const CONFIGS = [
    { id:'r1', fixed:'p1',  flex:'p2',  side:'left'  }, // r1: p1 크기 조정
    { id:'r2', fixed:'p2',  flex:'p3',  side:'left'  }, // r2: p2 크기 조정
    { id:'r3', fixed:'p4',  flex:'p3',  side:'right' }, // r3: p4 크기 조정 (p3는 건드리지 않음)
  ];

  const defaults = { p1:'200px', p2:'260px', p4:'220px' };

  CONFIGS.forEach(({ id, fixed, flex: flexPanel, side }) => {
    const resizer    = document.getElementById(id);
    const fixedEl    = document.getElementById(fixed);
    const flexEl     = document.getElementById(flexPanel);
    if (!resizer || !fixedEl) return;

    // 저장된 너비 복원 (fixed 패널만)
    const saved = localStorage.getItem(`pw_${fixed}`);
    if (saved) { fixedEl.style.width = saved; fixedEl.style.flex = `0 0 ${saved}`; }

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizer.classList.add('dragging');

      const startX   = e.clientX;
      const startW   = fixedEl.getBoundingClientRect().width;
      const minW     = parseInt(fixedEl.style.minWidth)  || 140;
      const maxW     = parseInt(fixedEl.style.maxWidth)  || 600;

      const onMove = (mv) => {
        const dx   = mv.clientX - startX;
        // side=left: 드래그 오른쪽 → 커짐 / side=right: 드래그 왼쪽 → 커짐
        const newW = Math.max(minW, Math.min(maxW,
          side === 'left' ? startW + dx : startW - dx
        ));
        fixedEl.style.width = `${newW}px`;
        fixedEl.style.flex  = `0 0 ${newW}px`;
      };

      const onUp = () => {
        resizer.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        localStorage.setItem(`pw_${fixed}`, fixedEl.style.width);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    // 더블클릭 → 기본값 복원
    resizer.addEventListener('dblclick', () => {
      const def = defaults[fixed];
      if (def) {
        fixedEl.style.width = def;
        fixedEl.style.flex  = `0 0 ${def}`;
        localStorage.removeItem(`pw_${fixed}`);
      }
    });
  });
})();

// ── 저장된 API 키 자동 복원 ──────────────────────────
(async () => {
  const gKey = localStorage.getItem('geminiKey');
  const cKey = localStorage.getItem('claudeKey');
  const cModel = localStorage.getItem('claudeModel');
  if (gKey) {
    document.getElementById('geminiKey').value = gKey;
    const gModel = localStorage.getItem('geminiModel') || 'gemini-2.0-flash-lite';
    const sel = document.getElementById('geminiModel');
    if (sel) {
      // 저장된 모델이 목록에 없으면 첫 번째로
      const opt = [...sel.options].find(o => o.value === gModel);
      sel.value = opt ? gModel : sel.options[0].value;
    }
    // 자동 연결 안 함 — 사용자가 직접 버튼 클릭
    addLog(`저장된 Gemini 키 복원됨 — "Gemini 연결" 버튼을 클릭하세요`, 'info');
  }
  if (cKey) {
    document.getElementById('claudeKey').value = cKey;
    if (cModel) document.getElementById('claudeModel').value = cModel;
    const r = await fetch('/api/status').then(r => r.json());
    if (!r.claude) await post('/api/claude/init', { apiKey: cKey, model: cModel || 'claude-opus-4-5' });
    else { state.claudeReady = true; setBadge('claudebadge', 'Claude ✅', 'ok'); }
  }
  addLog('📚 도서집필도우미 v4 시작됨', 'success');
  addLog('API 키 입력 → 기획서 업로드 → 목차 생성 → 집필 시작', 'info');
})();
