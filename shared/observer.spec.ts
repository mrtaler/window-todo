import { test } from "node:test";
import assert from "node:assert/strict";
import { applyObserverChange, OBSERVER_TEXT_MAX, observerPrompt, parseObserverReply } from './observer';
import { addItem, displayOrder, emptyWindow } from './window';
import type { WindowList } from './window';
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
