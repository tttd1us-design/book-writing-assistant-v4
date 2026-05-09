/**
 * Claude API 직접 호출 모듈 (스트리밍 지원)
 * - claude-opus-4-5 / claude-sonnet-4-5 선택
 * - 토큰 한도 도달 시 자동 이어쓰기
 * - 분량 부족 시 자동 재생성
 */
const Anthropic = require('@anthropic-ai/sdk');

class ClaudeModule {
  constructor(io) {
    this.io = io;
    this.client = null;
    this.model = 'claude-opus-4-5';
    this.maxTokens = 16000;
    this.isStreaming = false;
    this.stopRequested = false;
  }

  emit(ev, data) { if (this.io) this.io.emit(ev, data); }

  init(apiKey, model = 'claude-opus-4-5') {
    if (!apiKey || apiKey.trim().length < 20) throw new Error('유효하지 않은 Anthropic API 키');
    this.client = new Anthropic({ apiKey: apiKey.trim() });
    this.model = model;
    this.emit('claude:ready', { model: this.model, message: `Claude ${this.model} 연결 완료` });
    return true;
  }

  isReady() { return !!this.client; }
  stopStream() { this.stopRequested = true; }

  // ── 챕터 집필 (스트리밍 + 자동 이어쓰기) ──────────────
  async writeChapter(prompt, targetChars, chapterId) {
    if (!this.isReady()) throw new Error('Claude API 키를 먼저 설정하세요');

    this.stopRequested = false;
    this.isStreaming = true;
    let fullContent = '';
    let continueCount = 0;
    const MAX_CONTINUE = 5;

    this.emit('claude:start', { chapterId, message: '집필 시작...' });

    try {
      while (fullContent.length < targetChars * 0.85 && continueCount < MAX_CONTINUE) {
        if (this.stopRequested) break;

        const messages = continueCount === 0
          ? [{ role: 'user', content: prompt }]
          : [
              { role: 'user', content: prompt },
              { role: 'assistant', content: fullContent },
              { role: 'user', content: `이어서 계속 작성해주세요. 현재 ${fullContent.length.toLocaleString()}자 작성됨. 목표: ${targetChars.toLocaleString()}자. 앞 내용과 자연스럽게 연결하여 계속 작성.` },
            ];

        const stream = await this.client.messages.stream({
          model: this.model,
          max_tokens: this.maxTokens,
          messages,
        });

        for await (const chunk of stream) {
          if (this.stopRequested) break;
          if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
            fullContent += chunk.delta.text;
            this.emit('claude:streaming', {
              chapterId,
              chunk: chunk.delta.text,
              total: fullContent.length,
              progress: Math.min(100, Math.round(fullContent.length / targetChars * 100)),
            });
          }
        }

        const finalMsg = await stream.finalMessage();
        const stopReason = finalMsg.stop_reason;

        if (stopReason === 'end_turn' && fullContent.length >= targetChars * 0.85) break;
        if (stopReason === 'max_tokens' && fullContent.length < targetChars * 0.85) {
          continueCount++;
          this.emit('claude:continuing', { chapterId, count: continueCount, chars: fullContent.length });
          continue;
        }
        break;
      }

      this.isStreaming = false;
      this.emit('claude:done', {
        chapterId,
        chars: fullContent.length,
        continued: continueCount,
        sufficient: fullContent.length >= targetChars * 0.7,
      });

      return { success: true, content: fullContent, chars: fullContent.length, continued: continueCount };
    } catch (err) {
      this.isStreaming = false;
      this.emit('claude:error', { chapterId, message: err.message });
      return { success: false, message: err.message };
    }
  }

  // ── 단순 텍스트 생성 (스트리밍 없음) ────────────────
  async generate(prompt, maxTokens = 4096) {
    if (!this.isReady()) throw new Error('Claude 미연결');
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0]?.text || '';
  }

  // ── 기획서 → 목차 생성 (Gemini 대체) ────────────────
  async generateOutline(planningText, totalTarget = 4000000) {
    if (!this.isReady()) throw new Error('Claude 미연결');
    this.emit('claude:analyzing', { message: 'Claude로 목차 생성 중...' });

    // PDF가 너무 길면 앞부분만 사용
    const planningSnippet = planningText.substring(0, 25000);

    const prompt = `아래 기획서를 분석해서 도서 목차를 JSON 배열로 만들어주세요.

기획서:
${planningSnippet}

규칙:
1. type은 반드시: 프롤로그, 르포, 에세이, 대화, 에필로그 중 하나
2. partNum: 프롤로그=0, PART1=1, PART2=2, PART3=3, PART4=4, 에필로그=5
3. 총 targetChars 합계 = ${totalTarget}자에 근접
4. 반드시 JSON 배열만 출력. 설명 문장 절대 금지.
5. title 값에 큰따옴표(") 사용 금지. 작은따옴표나 다른 표현으로 대체.

출력 형식 (summary 없이):
[{"id":1,"num":1,"type":"프롤로그","title":"제목","partNum":0,"targetChars":20000},{"id":2,"num":2,"type":"르포","title":"제목","partNum":1,"targetChars":50000}]`;

    try {
      const text = await this.generate(prompt, 8000);

      // 디버그: 앞 200자 로그
      this.emit('claude:analyzing', { message: `Claude 응답 수신 (${text.length}자) — JSON 파싱 중...` });
      this.io?.emit('log:debug', { message: `Claude 응답 앞부분: ${text.substring(0, 150)}` });

      const raw  = this._parseJSONArray(text);

      const chapters = raw.map((ch, i) => ({
        id: ch.id || i + 1, num: ch.num || i + 1,
        type: ch.type || '르포', title: ch.title || `챕터 ${i + 1}`,
        partNum: ch.partNum ?? 1,
        targetChars: ch.targetChars || Math.floor(totalTarget / raw.length),
        summary: ch.summary || '',
        status: 'pending', writtenChars: 0, content: '', chapterSummary: '',
      }));

      this.emit('claude:outline-done', { chapters, count: chapters.length });
      return { success: true, chapters };
    } catch (err) {
      this.emit('claude:error', { message: `목차 생성 실패: ${err.message.substring(0,100)}` });
      this.io?.emit('status:change', { status: 'idle', message: '목차 생성 실패' });
      return { success: false, message: err.message };
    }
  }

  // ── JSON 배열 추출 (어떤 형태든 처리) ───────────────
  _parseJSONArray(text) {
    // 코드블록 제거 → 순수 텍스트만 추출
    const cleaned = text
      .replace(/```[a-z]*\s*/gi, '')  // ```json 등 시작 태그 제거
      .replace(/```/g, '');           // 닫는 ``` 제거

    // 첫 [ 와 마지막 ] 사이 추출
    const start = cleaned.indexOf('[');
    const end   = cleaned.lastIndexOf(']');
    if (start === -1 || end <= start) {
      throw new Error('JSON 배열을 찾을 수 없습니다');
    }

    let jsonStr = cleaned.slice(start, end + 1);

    // 시도 1: 직접 파싱
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (_) {}

    // 시도 2: summary 필드 통째로 제거 후 파싱 (큰따옴표 오염 방지)
    try {
      const noSummary = jsonStr.replace(/"summary"\s*:\s*"[^"]*"/g, '"summary":""');
      const parsed = JSON.parse(noSummary);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (_) {}

    // 시도 3: 마지막 불완전 객체 제거
    try {
      const lastComma = jsonStr.lastIndexOf(',\n{');
      if (lastComma < 0) { const lc2 = jsonStr.lastIndexOf(',{"'); if (lc2 > 0) jsonStr = jsonStr.slice(0, lc2) + ']'; }
      else jsonStr = jsonStr.slice(0, lastComma) + ']';
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (_) {}

    throw new Error('JSON 파싱 실패 — Claude 응답 형식 오류');
  }

  // ── 대화형 목차 수정 ─────────────────────────────────
  async refineTOC(userMsg, currentChapters, totalTarget = 4000000) {
    if (!this.isReady()) throw new Error('Claude 미연결');
    const tocSummary = currentChapters.map((ch, i) =>
      `${i+1}. [P${ch.partNum}/${ch.type}] ${ch.title} (${(ch.targetChars/1000).toFixed(0)}k자)`
    ).join('\n');
    const prompt = `도서 편집 전문가로서 아래 목차를 수정해주세요.
현재 목차:\n${tocSummary}\n목표: ${totalTarget.toLocaleString()}자
사용자 요청: ${userMsg}
변경 시 전체 목록을 \`\`\`json\`\`\` 블록으로 포함해서 응답하세요.`;
    try {
      const responseText = await this.generate(prompt, 6000);
      let updatedChapters = null;
      try {
        const parsed = this._parseJSONArray(responseText);
        if (Array.isArray(parsed) && parsed.length > 0) {
          updatedChapters = parsed.map((ch, i) => ({
            id: ch.id || i + 1, num: ch.num || i + 1, type: ch.type || '르포',
            title: ch.title || `챕터 ${i+1}`, partNum: ch.partNum ?? 1,
            targetChars: ch.targetChars || 10000, summary: ch.summary || '',
            status: currentChapters.find(c => c.id === ch.id)?.status || 'pending',
            writtenChars: currentChapters.find(c => c.id === ch.id)?.writtenChars || 0,
            content: currentChapters.find(c => c.id === ch.id)?.content || '',
            chapterSummary: '',
          }));
        }
      } catch (_) {}
      this.emit('claude:toc-response', { message: responseText, updatedChapters });
      return { success: true, response: responseText, updatedChapters };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // ── 일반 채팅 ─────────────────────────────────────────
  async chat(userMsg, contextInfo = {}) {
    if (!this.isReady()) throw new Error('Claude 미연결');
    const context = contextInfo.bookTitle
      ? `[도서: ${contextInfo.bookTitle} / 챕터: ${contextInfo.chaptersCount || 0}개 / 작성: ${(contextInfo.writtenChars || 0).toLocaleString()}자]`
      : '';
    try {
      const responseText = await this.generate(
        `당신은 도서 집필 전문 AI 비서입니다. ${context}\n\n${userMsg}`, 4096
      );
      this.emit('claude:chat-response', { message: responseText });
      return { success: true, response: responseText };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // ── 챕터 요약 ─────────────────────────────────────────
  async summarizeChapter(chapter, content) {
    if (!this.isReady()) return '';
    try {
      return await this.generate(
        `다음 챕터 내용을 3~5줄로 요약해주세요 (다음 챕터 집필 컨텍스트용).\n챕터: ${chapter.title}\n내용: ${content.substring(0, 3000)}...`, 512
      );
    } catch (_) { return ''; }
  }
}

module.exports = ClaudeModule;
