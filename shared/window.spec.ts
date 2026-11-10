import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, closeItems, describeWindow, displayOrder, emptyWindow, hasOpenQuestion, normaliseId, parseStoredWindow, pruneDone, skipItems, windowLines, windowStatus, } from './window';
import type { WindowKind, WindowList } from './window';
// Adds items in order and fails the test on a refused add.
const withItems = (entries: Array<[
    WindowKind,
    string
]>, start: WindowList = emptyWindow()): WindowList => entries.reduce((list, [kind, title]) => {
    const result = addItem(list, kind, title);
    if ('error' in result)
        throw new Error(result.error);
    return result.list;
}, start);
const ids = (list: WindowList): string[] => displayOrder(list).map(item => item.id);
test('ids are numbered per kind', () => {
    const list = withItems([
        ['T', 'Write the store'],
        ['F', 'Upload bypasses the toggle'],
        ['T', 'Wire the observer'],
        ['Q', 'Pane or section?'],
    ]);
    assert.deepEqual(ids(list), ['T1', 'F1', 'T2', 'Q1']);
});
test('a closed id is never handed out again', () => {
    const closed = closeItems(withItems([['F', 'One'], ['F', 'Two']]), ['F2']).list;
    const next = withItems([['F', 'Three']], closed);
    assert.deepEqual(ids(next), ['F1', 'F3', 'F2']);
});
test('a stored list keeps its counters, so ids continue after a resume', () => {
    const stored = JSON.parse(JSON.stringify(closeItems(withItems([['W', 'CI'], ['W', 'Review']]), ['W1', 'W2']).list));
    const restored = parseStoredWindow(stored);
    assert.notEqual(restored, null);
    const next = withItems([['W', 'Deploy']], restored ?? emptyWindow());
    assert.equal(next.items.at(-1)?.id, 'W3');
});
test('pruneDone removes only the done items and keeps the counters', () => {
    const list = closeItems(withItems([['T', 'One'], ['F', 'Two'], ['T', 'Three']]), ['T1', 'T2']).list;
    const result = pruneDone(list);
    assert.deepEqual(result.changed, ['T1', 'T2']);
    assert.deepEqual(ids(result.list), ['F1']);
    assert.equal(withItems([['T', 'Four']], result.list).items.at(-1)?.id, 'T3');
});
test('«F1 can wait» moves F1 to the bottom with the same id and keeps it open', () => {
    const list = withItems([['F', 'First'], ['T', 'Task'], ['F', 'Second']]);
    const result = skipItems(list, ['f1']);
    assert.deepEqual(result.changed, ['F1']);
    assert.deepEqual(ids(result.list), ['T1', 'F2', 'F1']);
    assert.equal(result.list.items.find(item => item.id === 'F1')?.isDone, false);
});
test('a skipped item stays above the done ones', () => {
    const list = closeItems(withItems([['T', 'A'], ['T', 'B'], ['T', 'C']]), ['T3']).list;
    assert.deepEqual(ids(skipItems(list, ['T1']).list), ['T2', 'T1', 'T3']);
});
test('unknown and malformed ids are reported and change nothing', () => {
    const list = withItems([['T', 'Only']]);
    const closed = closeItems(list, ['T9', 'X1', 'T1']);
    assert.deepEqual(closed.unknown, ['T9', 'X1']);
    assert.deepEqual(closed.changed, ['T1']);
    assert.deepEqual(skipItems(list, ['nothing']).list, list);
});
test('closing an item twice reports it once', () => {
    const once = closeItems(withItems([['Q', 'Ask']]), ['Q1']).list;
    assert.deepEqual(closeItems(once, ['Q1']).changed, []);
});
test('an empty or overlong title is refused, and control characters are cleaned', () => {
    assert.deepEqual(addItem(emptyWindow(), 'T', '   '), { error: 'The title is empty.' });
    assert.equal('error' in addItem(emptyWindow(), 'T', 'x'.repeat(121)), true);
    const result = addItem(emptyWindow(), 'T', 'a\u001b[31mb\nc');
    assert.equal('list' in result && result.list.items[0]?.title, 'a [31mb c');
});
test('normaliseId accepts any case and surrounding space only', () => {
    assert.equal(normaliseId(' f12 '), 'F12');
    assert.equal(normaliseId('F01'), 'F1');
    assert.equal(normaliseId('F'), null);
    assert.equal(normaliseId('FF1'), null);
});
test('an open question is seen only while it is open', () => {
    const list = withItems([['Q', 'Which pane?']]);
    assert.equal(hasOpenQuestion(list), true);
    assert.equal(hasOpenQuestion(closeItems(list, ['Q1']).list), false);
});
test('the status line counts open items per kind', () => {
    const list = closeItems(withItems([['T', 'a'], ['T', 'b'], ['F', 'c'], ['Q', 'd']]), ['F1']).list;
    assert.equal(windowStatus(list), 'T2 Q1');
    assert.equal(windowStatus(emptyWindow()), undefined);
});
test('the pane section is empty for an empty list and fits the width otherwise', () => {
    assert.deepEqual(windowLines(emptyWindow(), 40, 'claude'), []);
    const list = closeItems(withItems([['T', 'x'.repeat(80)], ['F', 'Done one']]), ['F1']).list;
    const lines = windowLines(list, 40, 'claude');
    assert.deepEqual(lines.map(line => line.text.slice(0, 6)), ['Window', '○ T1 x', '✓ F1 D']);
    assert.equal(lines.every(line => line.text.length <= 40), true);
    assert.equal(lines[2]?.segments.some(s => s.strikethrough === true), true);
});
test('describeWindow lists open items first with their state', () => {
    const list = closeItems(withItems([['T', 'a'], ['W', 'b']]), ['T1']).list;
    assert.equal(describeWindow(list), 'W1 [open] b\nT1 [done] a');
    assert.equal(describeWindow(emptyWindow()), 'The window list is empty.');
});
test('a stored value of another shape is not a list', () => {
    assert.equal(parseStoredWindow(undefined), null);
    assert.equal(parseStoredWindow({ items: [], issued: { T: 0 } }), null);
    assert.equal(parseStoredWindow({ items: [{ id: 'Z1', kind: 'Z', title: 't', isDone: false }], issued: { T: 0, F: 0, Q: 0, W: 0 } }), null);
});
