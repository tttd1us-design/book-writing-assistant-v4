/**
 * Gemini 2.0 Flash 모듈
 * - 기획서 분석 → 목차 생성
 * - 대화형 목차 수정
 * - 챕터 프롬프트 최적화
 * - 일반 채팅 (도서 작업 지시)
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiModule {
  constructor(io) {
    this.io = io;
    this.ai = null;
    this.model = null;
    this.apiKey = null;
    this.tocHistory = [];
    this.chatHistory = [];
  }

  emit(ev, data) { if (this.io) this.io.emit(ev, data); }

  init(apiKey, modelName = null) {
    if (!apiKey || apiKey.trim().length < 10) throw new Error('유효하지 않은 Gemini API 키');
    this.apiKey   = apiKey.trim();
    this.modelName = modelName || 'gemini-1.5-flash';
    this.ai = new GoogleGenerativeAI(this.apiKey);
    this.model = this.ai.getGenerativeModel({
      model: this.modelName,
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    });
    this.tocHistory = [];
    this.chatHistory = [];
    this.emit('gemini:ready', { message: `Gemini ${this.modelName} 연결 완료` });
    return true;
  }

  async listModels() {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`
      );
      const data = await res.json();
      return (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({ id: m.name.replace('models/', ''), displayName: m.displayName }));
    } catch (_) { return []; }
  }

  isReady() { return !!this.model; }

  // ── 기획서 → 목차 생성 ──────────────────────────────
  async generateOutline(planningText, totalTarget = 4000000) {
    if (!this.isReady()) throw new Error('Gemini API 키를 먼저 설정하세요');
    this.emit('gemini:analyzing', { message: '기획서 분석 중...' });

    const prompt = `당신은 한국 베스트셀러 도서 편집 전문가입니다.
아래 기획서를 분석하여 완전한 목차를 JSON 형식으로 생성해주세요.

## 기획서
${planningText.substring(0, 40000)}

## 요구사항
- 총 목표 글자수: ${totalTarget.toLocaleString()}자
- 각 챕터 type: 프롤로그 | 르포 | 에세이 | 대화 | 에필로그 | 인터뷰 | 칼럼
- partNum: 프롤로그=0, PART1=1, PART2=2, PART3=3, PART4=4, 에필로그=5
- targetChars 합계가 ${totalTarget}에 근접하도록
- 반드시 JSON 배열만 응답 (설명 없이)

## JSON 형식
[
  {"id":1,"num":1,"type":"프롤로그","title":"제목","partNum":0,"targetChars":20000,"summary":"이 챕터에서 다룰 내용 한 줄 요약"},
  {"id":2,"num":2,"type":"르포","title":"제목","partNum":1,"targetChars":55000,"summary":"요약"},
  ...
]`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().trim();
      const jsonStr = (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text])[1].trim();
      const arr = jsonStr.match(/\[[\s\S]*\]/)?.[0] || jsonStr;
      let chapters = JSON.parse(arr);

      chapters = chapters.map((ch, i) => ({
        id: ch.id || i + 1,
        num: ch.num || i + 1,
        type: ch.type || '르포',
        title: ch.title || `챕터 ${i + 1}`,
        partNum: ch.partNum ?? 1,
        targetChars: ch.targetChars || Math.floor(totalTarget / chapters.length),
        summary: ch.summary || '',
        status: 'pending',
        writtenChars: 0,
        content: '',
        chapterSummary: '',
      }));

      // 대화 기록 초기화
      this.tocHistory = [
        { role: 'user',  parts: [{ text: `${chapters.length}개 챕터 목차를 생성했습니다.` }] },
        { role: 'model', parts: [{ text: `목차 생성 완료. 수정이 필요하면 말씀해 주세요.` }] },
      ];

      this.emit('gemini:outline-done', { chapters, count: chapters.length });
      return { success: true, chapters };
    } catch (err) {
      const msg = this._friendlyError(err.message);
      this.emit('gemini:error', { message: `목차 생성 실패: ${msg}` });
      return { success: false, message: msg };
    }
  }

  // ── 대화형 목차 수정 ─────────────────────────────────
  async refineTOC(userMsg, currentChapters, totalTarget = 4000000) {
    if (!this.isReady()) throw new Error('Gemini 미연결');
    this.emit('gemini:thinking', { message: '목차 수정 중...' });

    const tocSummary = currentChapters.map((ch, i) =>
      `${i+1}. [P${ch.partNum}/${ch.type}] ${ch.title} (${(ch.targetChars/1000).toFixed(0)}k자)`
    ).join('\n');

    if (this.tocHistory.length === 0) {
      this.tocHistory = [
        { role: 'user',  parts: [{ text: `현재 목차:\n${tocSummary}` }] },
        { role: 'model', parts: [{ text: '목차를 확인했습니다. 수정 사항을 말씀해 주세요.' }] },
      ];
    }

    const sysPrompt = `도서 편집 전문가로서 목차를 수정해주세요.
현재 목차:\n${tocSummary}\n목표: ${totalTarget.toLocaleString()}자
변경 시 전체 목록을 \`\`\`json\`\`\` 블록으로 포함. 사용자 요청: ${userMsg}`;

    try {
      const chat = this.model.startChat({ history: this.tocHistory });
      const result = await chat.sendMessage(sysPrompt);
      const responseText = result.response.text();

      this.tocHistory.push({ role: 'user',  parts: [{ text: userMsg }] });
      this.tocHistory.push({ role: 'model', parts: [{ text: responseText }] });
      if (this.tocHistory.length > 24) this.tocHistory = this.tocHistory.slice(-20);

      let updatedChapters = null;
      const jm = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jm) {
        try {
          const parsed = JSON.parse(jm[1].trim());
          if (Array.isArray(parsed) && parsed.length > 0) {
            updatedChapters = parsed.map((ch, i) => ({
              id: ch.id || i + 1, num: ch.num || i + 1, type: ch.type || '르포',
              title: ch.title || `챕터 ${i+1}`, partNum: ch.partNum ?? 1,
              targetChars: ch.targetChars || 10000, summary: ch.summary || '',
              status: currentChapters.find(c => c.id === ch.id)?.status || 'pending',
              writtenChars: currentChapters.find(c => c.id === ch.id)?.writtenChars || 0,
              content: currentChapters.find(c => c.id === ch.id)?.content || '',
              chapterSummary: currentChapters.find(c => c.id === ch.id)?.chapterSummary || '',
            }));
          }
        } catch (_) {}
      }

      this.emit('gemini:toc-response', { message: responseText, updatedChapters });
      return { success: true, response: responseText, updatedChapters };
    } catch (err) {
      this.emit('gemini:error', { message: err.message });
      return { success: false, message: err.message };
    }
  }

  // ── 일반 채팅 ────────────────────────────────────────
  async chat(userMsg, contextInfo = {}) {
    if (!this.isReady()) throw new Error('Gemini 미연결');
    this.emit('gemini:chat-thinking', { message: '생각 중...' });

    const context = contextInfo.bookTitle
      ? `[도서: ${contextInfo.bookTitle} / 챕터: ${contextInfo.chaptersCount || 0}개 / 작성: ${(contextInfo.writtenChars || 0).toLocaleString()}자]`
      : '';

    const fullMsg = this.chatHistory.length === 0
      ? `당신은 도서 집필 전문 AI 비서입니다. ${context}\n\n${userMsg}`
      : userMsg;

    try {
      const chat = this.model.startChat({ history: this.chatHistory.slice(-20) });
      const result = await chat.sendMessage(fullMsg);
      const responseText = result.response.text();

      this.chatHistory.push({ role: 'user',  parts: [{ text: userMsg }] });
      this.chatHistory.push({ role: 'model', parts: [{ text: responseText }] });
      if (this.chatHistory.length > 30) this.chatHistory = this.chatHistory.slice(-26);

      this.emit('gemini:chat-response', { message: responseText });
      return { success: true, response: responseText };
    } catch (err) {
      this.emit('gemini:error', { message: err.message });
      return { success: false, message: err.message };
    }
  }

  // ── 챕터 자동 요약 생성 ──────────────────────────────
  async summarizeChapter(chapter, content) {
    if (!this.isReady()) return '';
    try {
      const prompt = `다음 챕터 내용을 3~5줄로 요약해주세요. 다음 챕터 집필 시 컨텍스트로 사용됩니다.
챕터: ${chapter.title}
내용: ${content.substring(0, 3000)}...
요약 (3~5줄):`;
      const result = await this.model.generateContent(prompt);
      return result.response.text().trim();
    } catch (_) { return ''; }
  }

  // ── 목차 AI 검토 ─────────────────────────────────────
  async reviewOutline(chapters, totalTarget) {
    if (!this.isReady()) return null;
    const summary = chapters.map(ch =>
      `[P${ch.partNum}/${ch.type}] ${ch.title}: ${(ch.targetChars/1000).toFixed(0)}k자`
    ).join('\n');
    const total = chapters.reduce((s, c) => s + (c.targetChars || 0), 0);
    try {
      const result = await this.model.generateContent(
        `목차 검토 (구성 균형, 분량 배분, 개선점 3~5줄):\n${summary}\n총: ${total.toLocaleString()}자 / 목표: ${totalTarget.toLocaleString()}자`
      );
      return result.response.text().trim();
    } catch (_) { return null; }
  }

  _friendlyError(msg) {
    if (msg.includes('429')) return '요청 한도 초과 — 다른 모델을 선택하거나 잠시 후 다시 시도하세요';
    if (msg.includes('404')) return `모델을 찾을 수 없음 (${this.modelName}) — "↻ 사용 가능 모델 조회" 버튼으로 모델을 다시 선택하세요`;
    if (msg.includes('403')) return 'API 키 권한 없음 — API 키를 확인하세요';
    if (msg.includes('API key')) return '유효하지 않은 API 키';
    return msg.substring(0, 120);
  }

  clearTocHistory()  { this.tocHistory = []; }
  clearChatHistory() { this.chatHistory = []; }
}

module.exports = GeminiModule;
