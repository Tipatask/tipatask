'use strict';

// Hand-synced with api/src/lib/transliteration.js; the adjacent test checks byte
// parity when the API checkout exists. Wraps transliteration with a Ukrainian pass.
// Output matches /^[a-z0-9 -]*$/. No language hint: umlauts fold plainly, kana
// and Hangul use package defaults, kanji uses Mandarin pinyin, and Cyrillic uses
// Ukrainian values. Callers choose their own separator.

const { transliterate: unidecode } = require('transliteration');

// Ukrainian (KMU 55:2010) Cyrillic -> Latin, lowercase keys. и/г/е etc. use Ukrainian
// values, not Russian, and ы/э (Russian-only letters) are included since admins/users
// type mixed Cyrillic in practice — ported from api/web/src/lib/statuses.js's
// transliterateToSlug() CYRILLIC_MAP (C1190).
const CYRILLIC_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z',
  и: 'y', і: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ь: '', ъ: '', ы: 'y', э: 'e',
};

// Word-initial vs. mid-word forms for the letters KMU 55:2010 romanizes positionally —
// checked against the still-untransliterated source char, same table as statuses.js.
const POSITIONAL = {
  є: ['ye', 'ie'], ї: ['yi', 'i'], й: ['y', 'i'], ю: ['yu', 'iu'], я: ['ya', 'ia'], ё: ['yo', 'io'],
};

const WORD_CHAR_RE = /[a-zа-яіїєґ0-9]/;
// Guard: any Cyrillic block char present -> run the Ukrainian pass. Cheap RegExp.test so
// pure-Latin/CJK/Hangul input (the common case) pays only this one check.
const CYRILLIC_RE = /[Ѐ-ӿ]/;

function ukrainianPass(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === 'з' && s[i + 1] === 'г') { out += 'zgh'; i++; continue; } // digraph exception, else collides with ж -> zh
    if (POSITIONAL[ch]) {
      const wordInitial = !WORD_CHAR_RE.test(s[i - 1] || '');
      out += POSITIONAL[ch][wordInitial ? 0 : 1];
      continue;
    }
    out += Object.prototype.hasOwnProperty.call(CYRILLIC_MAP, ch) ? CYRILLIC_MAP[ch] : ch;
  }
  return out;
}

// transliterate(text) -> ASCII string matching /^[a-z0-9 -]*$/.
//
// Order matters:
//   1. NFKC (never NFD/NFKD) — composes, doesn't decompose. Decomposing first (NFD) would
//      split й -> и + combining breve and ї -> і + combining diaeresis, so a later
//      combining-mark strip would silently turn "Йосип Їжак" into "Иосип Іжак" before the
//      Ukrainian pass below ever sees the real й/ї. task-prefix.js used to have exactly
//      this ordering bug (NFD-fold before its own Cyrillic map) — fixed by C1573, which
//      repointed it at this module instead. NFKC also folds half-width katakana + composes
//      dakuten for free.
//   2. Strip apostrophes as a no-op, not a word boundary — needed so Ukrainian "м'яч"
//      still reads я as mid-word ("miach", not "myach"). Side effect: French elisions
//      merge ("d'Artagnan" -> "dartanian"); accepted.
//   3. Capital ẞ (U+1E9E) is a real bug in the transliteration package — it maps to
//      nothing rather than "SS". Fix by hand; lowercase ß already maps to "ss" correctly.
//   4. Ukrainian pre-pass (guarded), before the package ever sees the text.
//   5. Package handles everything else: French/Spanish/pt-BR accents, Polish, Turkish,
//      Chinese Simplified + Traditional (pinyin), Korean, Japanese kana, Greek, etc.
//   6. Post-pass: lowercase before the charset filter (so package output like "Grüße" ->
//      "Grusse" folds to "grusse"), collapse repeated hyphens before collapsing
//      whitespace (an em dash comes out of the package as "--"), trim.
function transliterate(text) {
  let s = String(text == null ? '' : text).normalize('NFKC');
  s = s.replace(/['’ʼ`]/g, '');
  s = s.replace(/ẞ/g, 'ss');
  if (CYRILLIC_RE.test(s)) s = ukrainianPass(s.toLowerCase());
  s = unidecode(s);
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-\s]+|[-\s]+$/g, '');
}

module.exports = { transliterate };
