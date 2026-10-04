import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopPageModel, DESKTOP_PAGE_SIZE } from './desktop-notifications-model.js';
import { setLocale, t, tc } from './i18n.js';

const entries = (n) => Array.from({ length: n }, (_, i) => ({ id: String(n - i) }));

test('desktop page shows the five newest and flags the rest for Show More', () => {
  assert.equal(DESKTOP_PAGE_SIZE, 5);
  assert.deepEqual(desktopPageModel([]), { total: 0, visible: [], hasMore: false, hidden: 0 });
  assert.deepEqual(desktopPageModel(entries(5)), { total: 5, visible: entries(5), hasMore: false, hidden: 0 });
  const twelve = desktopPageModel(entries(12));
  assert.equal(twelve.total, 12);
  assert.deepEqual(twelve.visible.map((e) => e.id), ['12', '11', '10', '9', '8']);
  assert.equal(twelve.hasMore, true);
  assert.equal(twelve.hidden, 7);
  assert.equal(desktopPageModel(undefined).total, 0);
});

test('notification count and pagination labels in English and Ukrainian', () => {
  try {
    setLocale('en');
    assert.deepEqual([1, 3, 12].map((n) => tc('notifCenter.count', n)), ['1 Notification', '3 Notifications', '12 Notifications']);
    assert.equal(t('notifCenter.showMore', { n: 7 }), 'Show more (+7)');
    setLocale('uk');
    assert.deepEqual([1, 3, 5, 21, 12].map((n) => tc('notifCenter.count', n)),
      ['1 сповіщення', '3 сповіщення', '5 сповіщень', '21 сповіщення', '12 сповіщень']);
    assert.equal(t('notifCenter.showMore', { n: 7 }), 'Показати ще (+7)');
    for (const key of ['expand', 'collapse', 'closePanel', 'empty', 'desktopDisabled', 'clearAll']) {
      assert.notEqual(t(`notifCenter.${key}`), `notifCenter.${key}`);
    }
  } finally { setLocale('en'); }
});
