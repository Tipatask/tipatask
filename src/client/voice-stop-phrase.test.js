import assert from 'node:assert/strict';
import { test } from 'node:test';

// (TPT9158) Thank You voice mode's stop phrase: matching, stripping, the toast label and the
// auto-stop decision, for both project languages.
const {
  STOP_PHRASES, DEFAULT_STOP_PHRASE_LOCALE, STOP_PHRASE_SETTLE_MS,
  stopPhrasesFor, stopPhraseLabel, endsWithStopPhrase, stripStopPhrase, createStopPhraseDetector,
} = await import('./voice-stop-phrase.js');
const { SILENCE_RMS_THRESHOLD } = await import('./voice-silence.js');
const { LOCALES } = await import('./i18n.js');

test('the stop phrases are thank you / thanks in English and дякую / дякую тобі in Ukrainian', () => {
  assert.deepEqual(STOP_PHRASES.en, ['thank you', 'thanks']);
  assert.deepEqual(STOP_PHRASES.uk, ['дякую', 'дякую тобі']);
  assert.equal(DEFAULT_STOP_PHRASE_LOCALE, 'en');
  assert.ok(Object.isFrozen(STOP_PHRASES) && Object.isFrozen(STOP_PHRASES.en) && Object.isFrozen(STOP_PHRASES.uk));
});

test('a locale picks its phrases by language code; anything else uses English', () => {
  assert.equal(stopPhrasesFor('uk'), STOP_PHRASES.uk);
  assert.equal(stopPhrasesFor('uk-UA'), STOP_PHRASES.uk);
  assert.equal(stopPhrasesFor(' UK '), STOP_PHRASES.uk);
  assert.equal(stopPhrasesFor('en_GB'), STOP_PHRASES.en);
  for (const locale of ['de', '', undefined, null, 42, 'toString', '__proto__']) {
    assert.equal(stopPhrasesFor(locale), STOP_PHRASES.en, JSON.stringify(locale));
  }
});

test('the toast label is the locale\'s first phrase, capitalized', () => {
  assert.equal(stopPhraseLabel('en'), 'Thank you');
  assert.equal(stopPhraseLabel('uk'), 'Дякую');
  assert.equal(stopPhraseLabel('fr'), 'Thank you');
});

test('English: a trailing thank you / thanks matches, ignoring case and punctuation', () => {
  for (const text of [
    'thank you', 'Thanks', 'THANK YOU', 'Fix the login bug. Thank you.', 'fix the login bug thank you',
    'Fix the login bug, thanks!', 'Okay… thanks...', 'Fix it — “Thank you”', 'fix it thank-you',
    'Fix it.Thank you!?', '  thank   you  \n', 'Ship it (thank you)',
  ]) {
    assert.equal(endsWithStopPhrase(text, 'en'), true, text);
  }
});

test('English: thank you elsewhere, part of a word or misheard does not match', () => {
  for (const text of [
    'thank you for the report', 'Thanks for checking', 'thankfully', 'no thank youuu', 'thank',
    'you', 'thanksgiving', 'say thank you to the team', 'thank you note', '', '   ', '...',
  ]) {
    assert.equal(endsWithStopPhrase(text, 'en'), false, text);
  }
  for (const value of [null, undefined, 42, {}, ['thank you']]) assert.equal(endsWithStopPhrase(value, 'en'), false);
});

test('Ukrainian: a trailing дякую / дякую тобі matches, ignoring case and punctuation', () => {
  for (const text of [
    'дякую', 'Дякую!', 'ДЯКУЮ ТОБІ', 'Виправ помилку входу. Дякую.', 'виправ помилку входу дякую',
    'Виправ помилку, дякую тобі!', 'Готово… «Дякую»', 'Дякую, тобі', 'п’ять хвилин, дякую',
  ]) {
    assert.equal(endsWithStopPhrase(text, 'uk'), true, text);
  }
  for (const text of ['дякую за звіт', 'подякую', 'дякуючи', 'тобі', 'дякую тобі за все', 'Дякую тобі й']) {
    assert.equal(endsWithStopPhrase(text, 'uk'), false, text);
  }
});

test('only the project language\'s phrases count', () => {
  assert.equal(endsWithStopPhrase('Fix it. Дякую.', 'en'), false);
  assert.equal(endsWithStopPhrase('Виправ це. Thank you.', 'uk'), false);
  assert.equal(endsWithStopPhrase('Fix it. Thank you.', 'de'), true, 'an unknown locale listens for English');
});

test('stripStopPhrase removes the phrase and the punctuation that joined it on', () => {
  const cases = [
    ['Fix the login bug. Thank you.', 'Fix the login bug.'],
    ['Fix the login bug, thank you', 'Fix the login bug'],
    ['Fix the login bug — thanks!', 'Fix the login bug'],
    ['Fix the login bug: thanks', 'Fix the login bug'],
    ['Fix the login bug thank-you', 'Fix the login bug'],
    ['Ship it (thank you)', 'Ship it'],
    ['Ship it “Thank you”', 'Ship it'],
    ['He said "done" thank you', 'He said "done"'],
    ['Is it fixed? Thanks.', 'Is it fixed?'],
    ['Say thank you thank you', 'Say thank you'],
    ['Thank you.', ''],
    ['  thanks  ', ''],
  ];
  for (const [text, expected] of cases) assert.equal(stripStopPhrase(text, 'en'), expected, text);
});

test('stripStopPhrase in Ukrainian takes the whole two-word phrase', () => {
  const cases = [
    ['Виправ помилку входу. Дякую тобі!', 'Виправ помилку входу.'],
    ['Виправ помилку входу, дякую', 'Виправ помилку входу'],
    ['п’ять хвилин — дякую.', 'п’ять хвилин'],
    ['Готово «Дякую»', 'Готово'],
    ['Дякую тобі.', ''],
  ];
  for (const [text, expected] of cases) assert.equal(stripStopPhrase(text, 'uk'), expected, text);
});

test('stripStopPhrase leaves text without the phrase as it is, trimmed', () => {
  assert.equal(stripStopPhrase('  thank you for the report  ', 'en'), 'thank you for the report');
  assert.equal(stripStopPhrase('Fix it. Дякую.', 'en'), 'Fix it. Дякую.');
  assert.equal(stripStopPhrase('', 'en'), '');
  assert.equal(stripStopPhrase(null, 'en'), '');
  // A combining mark stays with its letter: no word boundary inside "café", nothing lost.
  assert.equal(stripStopPhrase('café thank you', 'en'), 'café');
});

test('every stop phrase matches and strips to nothing on its own', () => {
  for (const [locale, phrases] of Object.entries(STOP_PHRASES)) {
    for (const phrase of phrases) {
      assert.equal(endsWithStopPhrase(phrase, locale), true, `${locale}: ${phrase}`);
      assert.equal(stripStopPhrase(`${phrase}.`, locale), '', `${locale}: ${phrase}`);
    }
  }
});

const QUIET = SILENCE_RMS_THRESHOLD / 4;
const LOUD = SILENCE_RMS_THRESHOLD * 4;

// Feeds quiet level frames every 50ms from `from` up to and including `to`; returns the time
// of the first frame that said stop, or null.
function quietUntil(detector, from, to) {
  for (let now = from; now <= to; now += 50) {
    if (detector.level(QUIET, now)) return now;
  }
  return null;
}

test('a final transcript ending with the phrase stops at once', () => {
  const detector = createStopPhraseDetector({ locale: 'en' });
  assert.equal(detector.heard('Fix the login bug.', { final: true, now: 0 }), false);
  assert.equal(detector.heard('Fix the login bug. Thank you.', { final: true, now: 100 }), true);
});

test('a partial ending with the phrase stops only after the mic stays quiet for the settle time', () => {
  const detector = createStopPhraseDetector({ locale: 'en' });
  assert.equal(detector.heard('fix the login bug thank you', { final: false, now: 1000 }), false);
  assert.equal(detector.pending, true);
  assert.equal(quietUntil(detector, 1050, 1000 + STOP_PHRASE_SETTLE_MS - 50), null, 'not before the settle time');
  assert.equal(detector.level(QUIET, 1000 + STOP_PHRASE_SETTLE_MS), true);
});

test('speech after the phrase restarts the quiet wait', () => {
  const detector = createStopPhraseDetector({ locale: 'en', settleMs: 1000 });
  detector.heard('fix the login bug thank you', { final: false, now: 0 });
  assert.equal(quietUntil(detector, 50, 800), null);
  assert.equal(detector.level(LOUD, 900), false, 'a louder frame never stops');
  assert.equal(quietUntil(detector, 950, 1850), null, 'quiet is counted from the last louder frame');
  assert.equal(detector.level(QUIET, 1900), true);
});

test('a mid-sentence "thank you" is dropped by the next partial and never stops the recording', () => {
  const detector = createStopPhraseDetector({ locale: 'en' });
  detector.heard('write a thank you', { final: false, now: 0 });
  detector.level(LOUD, 100); // still talking
  detector.heard('write a thank you note to the client', { final: false, now: 400 });
  assert.equal(detector.pending, false);
  assert.equal(quietUntil(detector, 450, 60_000), null, 'a minute of quiet afterwards changes nothing');
  assert.equal(detector.heard('Write a thank you note to the client.', { final: true, now: 61_000 }), false);
});

test('long pauses without the phrase never stop the recording', () => {
  const detector = createStopPhraseDetector({ locale: 'uk' });
  detector.level(LOUD, 0);
  detector.heard('виправ помилку входу', { final: false, now: 200 });
  assert.equal(quietUntil(detector, 250, 120_000), null);
  detector.heard('Виправ помилку входу.', { final: true, now: 120_100 });
  assert.equal(quietUntil(detector, 120_150, 240_000), null);
});

test('a repeated partial keeps its pending stop instead of restarting it', () => {
  const detector = createStopPhraseDetector({ locale: 'uk', settleMs: 1000 });
  detector.heard('виправ помилку дякую', { final: false, now: 0 });
  assert.equal(quietUntil(detector, 50, 600), null);
  detector.heard('Виправ помилку, дякую', { final: false, now: 650 });
  assert.equal(detector.level(QUIET, 1000), true);
});

test('Ukrainian detection: дякую тобі as a final stops; the English phrase does not', () => {
  const detector = createStopPhraseDetector({ locale: 'uk' });
  assert.equal(detector.heard('Fix it. Thank you.', { final: true, now: 0 }), false);
  assert.equal(detector.heard('Виправ це. Дякую тобі!', { final: true, now: 10 }), true);
});

test('the toast strings carry their placeholders in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(table['voice.sayStopPhrase']?.includes('{phrase}'), `${locale}.voice.sayStopPhrase`);
    assert.ok(table['voice.stopPhraseUnavailable']?.includes('{phrase}'), `${locale}.voice.stopPhraseUnavailable keeps {phrase}`);
    assert.ok(table['voice.stopPhraseUnavailable']?.includes('{shortcut}'), `${locale}.voice.stopPhraseUnavailable keeps {shortcut}`);
    for (const key of ['voice.transcribing', 'voice.cleaningUp']) {
      assert.ok(typeof table[key] === 'string' && table[key].trim(), `${locale}.${key}`);
    }
  }
});
