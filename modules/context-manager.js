/**
 * 400만자 일관성 관리 시스템 (핵심)
 * - 챕터 완료마다 자동 요약 저장
 * - 이전 5챕터 요약을 다음 챕터 프롬프트에 자동 주입
 * - 등장인물 DB, 용어 사전, 금지어, 문체 가이드 관리
 */
class ContextManager {
  constructor() {
    this.bookTitle   = '';
    this.totalTarget = 4000000;
    this.characters  = [];     // { name, age, occupation, traits, firstChapter }
    this.themes      = [];     // 핵심 테마 목록
    this.keywords    = [];     // 주요 용어/개념
    this.prohibited  = [];     // 금지어
    this.writingStyle = '';    // 문체 가이드
    this.chapterSummaries = {}; // chapterId → summary string
    this.worldNotes  = '';     // 세계관/배경 메모
  }

  // ── 기획서 분석 결과로 초기화 ──────────────────────
  initFromBible(bookBible) {
    if (!bookBible) return;
    this.bookTitle    = bookBible.title    || '';
    this.totalTarget  = bookBible.totalTarget || 4000000;
    this.characters   = bookBible.characters  || [];
    this.themes       = bookBible.themes      || [];
    this.keywords     = bookBible.keywords    || [];
    this.prohibited   = bookBible.prohibitedWords || [];
    this.writingStyle = bookBible.writingStyle || '';
    this.worldNotes   = bookBible.worldNotes  || '';
  }

  // ── 챕터 완료 시 요약 저장 ─────────────────────────
  saveChapterSummary(chapterId, summary) {
    this.chapterSummaries[chapterId] = summary;
  }

  // ── 이전 N개 챕터 요약 가져오기 ────────────────────
  getRecentSummaries(beforeChapterId, count = 5) {
    const keys = Object.keys(this.chapterSummaries)
      .map(Number)
      .filter(id => id < beforeChapterId)
      .sort((a, b) => b - a)
      .slice(0, count)
      .reverse();
    return keys.map(id => ({
      id,
      summary: this.chapterSummaries[id],
    }));
  }

  // ── 챕터 프롬프트 컨텍스트 블록 생성 ───────────────
  buildContextBlock(chapterId) {
    const parts = [];

    // 이전 챕터 요약
    const summaries = this.getRecentSummaries(chapterId);
    if (summaries.length > 0) {
      parts.push(`## 이전 챕터 흐름 (연속성 유지 필수)
${summaries.map(s => `- 챕터 ${s.id}: ${s.summary}`).join('\n')}`);
    }

    // 등장인물
    if (this.characters.length > 0) {
      const charList = this.characters
        .slice(0, 10)
        .map(c => `${c.name}(${c.age || '?'}세, ${c.occupation || ''})`)
        .join(', ');
      parts.push(`## 등장인물\n${charList}`);
    }

    // 핵심 테마
    if (this.themes.length > 0) {
      parts.push(`## 핵심 테마\n${this.themes.join(', ')}`);
    }

    // 문체 가이드
    if (this.writingStyle) {
      parts.push(`## 문체 가이드\n${this.writingStyle}`);
    }

    // 금지어
    if (this.prohibited.length > 0) {
      parts.push(`## 절대 금지\n"${this.prohibited.slice(0, 10).join('", "')}" — 이 단어들은 절대 사용 금지`);
    }

    // 세계관 메모
    if (this.worldNotes) {
      parts.push(`## 세계관/배경\n${this.worldNotes.substring(0, 500)}`);
    }

    return parts.join('\n\n');
  }

  // ── 등장인물 추가/수정 ──────────────────────────────
  upsertCharacter(char) {
    const idx = this.characters.findIndex(c => c.name === char.name);
    if (idx >= 0) this.characters[idx] = { ...this.characters[idx], ...char };
    else this.characters.push(char);
  }

  // ── 직렬화 (세션 저장용) ────────────────────────────
  toJSON() {
    return {
      bookTitle: this.bookTitle, totalTarget: this.totalTarget,
      characters: this.characters, themes: this.themes,
      keywords: this.keywords, prohibited: this.prohibited,
      writingStyle: this.writingStyle, worldNotes: this.worldNotes,
      chapterSummaries: this.chapterSummaries,
    };
  }

  fromJSON(data) {
    if (!data) return;
    Object.assign(this, data);
  }
}

module.exports = ContextManager;
