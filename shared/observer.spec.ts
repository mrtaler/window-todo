import { test } from "node:test";
import assert from "node:assert/strict";
import { applyObserverChange, NEAR_DUPLICATE_MIN, OBSERVER_TEXT_MAX, observerPrompt, parseObserverReply, RECENT_DONE_COUNT, titleSimilarity } from './observer';
import { addItem, displayOrder, emptyWindow, setDue } from './window';
import type { WindowKind, WindowList } from './window';
const listOf = (...titles: Array<[
    Parameters<typeof addItem>[1],
    string
]>): WindowList => titles.reduce((list, [kind, title]) => {
    const added = addItem(list, kind, title);
    if ('error' in added)
        throw new Error(added.error);
    return added.list;
}, emptyWindow());
test('a plain or fenced JSON reply is a change; ids are normalised', () => {
    assert.deepEqual(parseObserverReply('{"done":["t1"],"skip":[],"add":[{"kind":"q","title":"Pane?"}]}'), {
        done: ['T1'],
        skip: [],
        add: [{ kind: 'Q', title: 'Pane?' }],
    });
    assert.deepEqual(parseObserverReply('```json\n{"done":[],"skip":["F1"]}\n```'), { done: [], skip: ['F1'], add: [] });
});
test('a reply of another shape is not a change', () => {
    for (const text of ['', 'no', '[]', '{"done":"T1"}', '{"done":["X1"]}', '{"add":[{"kind":"Z","title":"t"}]}', '{"add":[{"kind":"T"}]}']) {
        assert.equal(parseObserverReply(text), null);
    }
});
test('«F1 can wait» from the observer moves F1 down with its id', () => {
    const list = listOf(['F', 'First'], ['T', 'Task']);
    const next = applyObserverChange(list, { done: [], skip: ['F1'], add: [] });
    assert.deepEqual(displayOrder(next).map(item => item.id), ['T1', 'F1']);
});
test('closes, skips and adds in one change, and drops an add the open list already has', () => {
    const list = listOf(['Q', 'Pane or section?'], ['T', 'Wire the store']);
    const next = applyObserverChange(list, {
        done: ['Q1'],
        skip: [],
        add: [
            { kind: 'T', title: '  Wire   the store ' },
            { kind: 'W', title: 'CI on the branch' },
            { kind: 'T', title: '   ' },
        ],
    });
    assert.deepEqual(displayOrder(next).map(item => `${item.id}:${item.isDone}`), ['T1:false', 'W1:false', 'Q1:true']);
});
test('the prompt carries the list with ids and clips long texts keeping the start and the end', () => {
    const prompt = observerPrompt(listOf(['F', 'Upload bypasses the toggle']), {
        userText: 'F1 can wait',
        answer: `START${'x'.repeat(OBSERVER_TEXT_MAX)}END`,
        previousAnswer: '',
    });
    assert.ok(prompt.includes('F1 [open] Upload bypasses the toggle'));
    assert.ok(prompt.includes('User message of this turn:\nF1 can wait'));
    assert.ok(prompt.includes('START'));
    assert.ok(prompt.includes('[truncated]'));
    assert.ok(prompt.includes('END'));
    assert.ok(prompt.includes('previous turn, which this turn\'s user message may reply to:\n(none)'));
    assert.ok(prompt.length < OBSERVER_TEXT_MAX + 1000);
});

test('the observer keeps the day of the items it closes, skips or leaves, and adds none', () => {
  const start = listOf(['W', 'Answer from DBA'], ['W', 'CI run'], ['T', 'Task'])
  const withDays = setDue(setDue(start, ['W1'], '2026-11-15').list, ['W2'], '2026-11-20').list
  // A reply that names a day for a new item is read without it: the observer does not set days.
  const change = parseObserverReply('{"done":["W2"],"skip":["W1"],"add":[{"kind":"W","title":"Deploy","due":"2026-11-30"}]}')
  assert.notEqual(change, null)
  const next = applyObserverChange(withDays, change ?? { done: [], skip: [], add: [] })
  assert.deepEqual(
    next.items.map(item => [item.id, item.isDone, item.due]),
    [['W2', true, '2026-11-20'], ['T1', false, undefined], ['W1', false, '2026-11-15'], ['W3', false, undefined]],
  )
  assert.equal('due' in (next.items.at(-1) ?? {}), false)
})

// Calibration titles from real windows (F19): the observer's restatements and distinct items
// that share the workflow words.
const PUSH_QUESTION = 'Пушить abe2ac6d (слияние develop + 3eefe282) в SPES-31653_vault-agent-poc?'
const PLAN_RESUME_DONE = 'SPES-30368: вернуться к варианту A по плану b78a919a, начать с шага 1 (согласие DBA)'
const PLAN_RESUME_AGAIN = 'SPES-30368: вернуться к плану b78a919a (столбец + view), начать с шага 1 — согласие DBA'

const closedAll = (list: WindowList): WindowList => ({ ...list, items: list.items.map(item => ({ ...item, isDone: true })) })
const titlesOf = (list: WindowList): string[] => list.items.map(item => item.title)

test('an add that restates an open item in other words is dropped', () => {
  const list = listOf(['Q', PUSH_QUESTION])
  const next = applyObserverChange(list, { done: [], skip: [], add: [{ kind: 'Q', title: `${PUSH_QUESTION} Ответа ещё не было` }] })
  assert.deepEqual(titlesOf(next), [PUSH_QUESTION])
  assert.equal(next.issued.Q, 1)
})

// RECENT_DONE_COUNT done waits after the first item, so it is not among the last done ones.
const fillers = Array.from({ length: RECENT_DONE_COUNT }, (_, index): [WindowKind, string] => ['W', `Ожидание номер ${index + 1}`])
const withDoneFillers = (list: WindowList): WindowList => ({
  ...list,
  items: list.items.map(item => (item.kind === 'W' ? { ...item, isDone: true } : item)),
})

test('an add that restates a recently done item, or one this change closes, is dropped', () => {
  const done = closedAll(listOf(['T', PLAN_RESUME_DONE]))
  assert.deepEqual(titlesOf(applyObserverChange(done, { done: [], skip: [], add: [{ kind: 'T', title: PLAN_RESUME_AGAIN }] })), [PLAN_RESUME_DONE])
  const open = withDoneFillers(listOf(['T', PLAN_RESUME_DONE], ...fillers))
  const next = applyObserverChange(open, { done: ['T1'], skip: [], add: [{ kind: 'T', title: PLAN_RESUME_AGAIN }] })
  assert.equal(next.items.length, RECENT_DONE_COUNT + 1)
  assert.equal(next.items.every(item => item.isDone), true)
})

test('a restatement of a done item older than the last RECENT_DONE_COUNT done ones is kept', () => {
  const list = closedAll(listOf(['T', PLAN_RESUME_DONE], ...fillers))
  const next = applyObserverChange(list, { done: [], skip: [], add: [{ kind: 'T', title: PLAN_RESUME_AGAIN }] })
  assert.equal(next.items.at(-1)?.title, PLAN_RESUME_AGAIN)
})

test('a new item next to items on the same subject is kept', () => {
  const list = listOf(
    ['W', 'Субагент: граница хода kb-save-reminder по isMeta/origin + случаи в kb_save_reminder_probe'],
    ['W', 'Вердикт intent-check по границе хода kb-save-reminder (0.51.4) → коммит плагина и каталога'],
  )
  const title = 'Замерить, как изменилась частота напоминаний kb-save-reminder за 14 дней после правки границы хода'
  const next = applyObserverChange(list, { done: [], skip: [], add: [{ kind: 'T', title }] })
  assert.equal(next.items.at(-1)?.title, title)
})

test('distinct items that share the common words, or differ in a version or hash, are kept', () => {
  const pairs: Array<[string, string]> = [
    ['Дождаться intent-check по индексу agent-plugins перед коммитом от mrTaler', 'Дождаться вердикта intent-check по agent-plugins, затем коммит'],
    ['Прочитать дифф субагента, перепрогнать пробы и проверить транскрипты, затем intent-check и коммит 0.51.3', 'kb-save-reminder: прочитать дифф субагента, перепрогнать пробы, intent-check и коммит 0.51.4'],
    ['Досчёт вектора заметки e9269419 (замер A на копии): эмбеддер не отвечает', 'Досчёт вектора заметки ff8fdd0c (замеры B и C на копии): эмбеддер не отвечает'],
    ['F24: засчитывать блок памяти КБ, который kb-agent-context вставляет в бриф, как чтение субагента?', 'F24: засчитывать ли блок КБ «consulted, nothing matched» как чтение субагента?'],
  ]
  for (const [existing, title] of pairs) {
    for (const list of [listOf(['W', existing]), closedAll(listOf(['W', existing]))]) {
      const next = applyObserverChange(list, { done: [], skip: [], add: [{ kind: 'W', title }] })
      assert.deepEqual(titlesOf(next), [existing, title], title)
    }
  }
})

test('an exact duplicate of an open item is still dropped, even when it has no words to compare', () => {
  const carried = '[T21] Дописать заметку в КБ 28af2f1d после переноса окна …fff'
  const list = listOf(['T', carried], ['Q', 'Да или нет?'])
  const next = applyObserverChange(list, {
    done: [],
    skip: [],
    add: [{ kind: 'T', title: ` ${carried} ` }, { kind: 'Q', title: 'Да или нет?' }],
  })
  assert.deepEqual(titlesOf(next), [carried, 'Да или нет?'])
})

test('titleSimilarity reads inflected words by their stem, ё as е, and lets one-sided identifiers through', () => {
  assert.equal(titleSimilarity('Проверить ещё раз сборку', 'проверка сборки, еще раз'), 1)
  assert.ok(titleSimilarity(PUSH_QUESTION, `${PUSH_QUESTION} Ответа ещё не было`) >= NEAR_DUPLICATE_MIN)
  assert.equal(titleSimilarity('Пуш тега v0.116.0 только по слову', 'Пуш тега v0.117.0 только по слову'), 0)
  assert.ok(titleSimilarity('Запушить feat/codex-resume-last (b5bc249) и открыть PR', 'Запушить feat/codex-resume-last и открыть PR') > 0.85)
  assert.equal(titleSimilarity('', 'Пуш тега'), 0)
})
