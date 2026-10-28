import { SILENCE_RMS_THRESHOLD } from './voice-silence.js';

// (TPT9158) Thank You voice mode's stop phrase — pure and DOM-free like voice-mode.js and
// voice-silence.js, so it is unit-testable under `node --test` with no browser. In Thank You
// mode every mic records until the speaker says the stop phrase in the project language
// (i18n.js getLocale()): audio-recorder.js feeds the live transcript to
// createStopPhraseDetector() below, then stripStopPhrase() takes the phrase off the finished
// transcript before the cleanup pass.

// Lowercase, as spoken. Matching compares the transcript's LAST words with each phrase, so a
// longer phrase that ends in another word (дякую тобі) needs its own entry.
export const STOP_PHRASES = Object.freeze({
  en: Object.freeze(['thank you', 'thanks']),
  uk: Object.freeze(['дякую', 'дякую тобі']),
});
export const DEFAULT_STOP_PHRASE_LOCALE = 'en';

// A word keeps its inner apostrophes (don't, п’ять, пʼять) and combining marks; everything
// else — punctuation, dashes, quotes, spaces — only separates words, which is how matching
// ignores punctuation.
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’ʼ][\p{L}\p{M}\p{N}]+)*/gu;

// What stripStopPhrase() trims off the end of the text left before the phrase: spaces and the
// commas, colons and dashes that joined the phrase on, plus quotes or brackets the phrase
// opened. Sentence punctuation (. ! ? …), closing quotes and straight quotes, which may close
// a quotation, stay.
const DANGLING_TAIL_RE = /[\s,;:\-‐‑‒–—―(\[{«‹“„‘‚]+$/u;

// 'uk', 'uk-UA' and 'UK' all mean uk; anything without phrases of its own uses English.
function localeKey(locale) {
  const code = typeof locale === 'string' ? locale.trim().toLowerCase().split(/[-_]/)[0] : '';
  return Object.hasOwn(STOP_PHRASES, code) ? code : DEFAULT_STOP_PHRASE_LOCALE;
}

export function stopPhrasesFor(locale) {
  return STOP_PHRASES[localeKey(locale)];
}

// The phrase the recording toast tells the speaker to say: the locale's first, capitalized
// ("Thank you", "Дякую").
export function stopPhraseLabel(locale) {
  const phrase = stopPhrasesFor(locale)[0];
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function normalizeWord(word) {
  return word.normalize('NFC').toLowerCase().replace(/[’ʼ]/g, "'");
}

// The index in `text` where a trailing stop phrase starts, or -1. Longer phrases are tried
// first, so the whole phrase is found when one phrase ends another.
function stopPhraseStart(text, locale) {
  if (typeof text !== 'string' || !text) return -1;
  const words = [...text.matchAll(WORD_RE)];
  const phrases = stopPhrasesFor(locale).map(phrase => phrase.split(' '))
    .sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    if (phrase.length > words.length) continue;
    const tail = words.slice(words.length - phrase.length);
    if (tail.every((match, i) => normalizeWord(match[0]) === phrase[i])) return tail[0].index;
  }
  return -1;
}

// Whether `text` ends with one of the locale's stop phrases as whole words, ignoring case and
// punctuation: "Fix it. Thank you!" and "…thanks" match, "thankfully" and "no thank youuu" do not.
export function endsWithStopPhrase(text, locale) {
  return stopPhraseStart(text, locale) !== -1;
}

// `text` without its trailing stop phrase and whatever joined it on, trimmed. Text that does
// not end with a stop phrase comes back trimmed and otherwise unchanged; '' when the text was
// only the stop phrase.
export function stripStopPhrase(text, locale) {
  if (typeof text !== 'string') return '';
  const start = stopPhraseStart(text, locale);
  if (start === -1) return text.trim();
  return text.slice(0, start).replace(DANGLING_TAIL_RE, '').trim();
}

// How long the mic must stay quiet after a partial transcript started ending with the stop
// phrase before the recording stops.
export const STOP_PHRASE_SETTLE_MS = 1200;

// Thank You mode's auto-stop decision. Timer-free, the caller passes the clock, so it is
// node --test-able. audio-recorder.js calls heard() with the whole live transcript (joined
// finals plus the current partial) after every partial and final, and level() with every mic
// level frame; a true from either means "stop now".
// - A FINAL transcript ending with the phrase stops at once: recognizers only finalize after
//   the speaker paused, so the phrase really ended what was said.
// - A PARTIAL ending with it only starts a pending stop. Partials grow word by word, so a
//   mid-sentence "thank you" ("write a thank you note…") is a partial's last words for a
//   moment. The pending stop fires once the mic level has stayed below `threshold` for
//   `settleMs` — measured from the partial or the last louder frame, whichever is later — and
//   is dropped by the next transcript that no longer ends with the phrase.
export function createStopPhraseDetector({ locale, settleMs = STOP_PHRASE_SETTLE_MS, threshold = SILENCE_RMS_THRESHOLD } = {}) {
  let pendingSince = null;
  let lastSpeechAt = null;

  function heard(text, { final = false, now }) {
    if (!endsWithStopPhrase(text, locale)) {
      pendingSince = null;
      return false;
    }
    if (final) return true;
    if (pendingSince === null) pendingSince = now;
    return false;
  }

  function level(rms, now) {
    if (rms >= threshold) {
      lastSpeechAt = now;
      return false;
    }
    if (pendingSince === null) return false;
    const quietSince = lastSpeechAt !== null && lastSpeechAt > pendingSince ? lastSpeechAt : pendingSince;
    return now - quietSince >= settleMs;
  }

  return {
    heard,
    level,
    get pending() { return pendingSince !== null; },
  };
}
