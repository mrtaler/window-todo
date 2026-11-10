import { test } from "node:test";
import assert from "node:assert/strict";
import { activeLeaves, addNodes, currentNode, emptyPlan, hasUnfinished, progress, removeNode, rollup, setPlan, updateNodes, validateConcurrency, } from './plan';
import type { Plan, PlanInputNode, PlanResult } from './plan';
// Unwraps a result that must succeed.
const ok = (r: PlanResult): Plan => {
    if ('error' in r)
        throw new Error(`expected a plan, got error: ${r.error}`);
    return r.plan;
};
const err = (r: PlanResult): string => {
    if ('plan' in r)
        throw new Error('expected an error, got a plan');
    return r.error;
};
const ids = (p: Plan): string[] => p.nodes.map(n => n.id);
const status = (p: Plan, id: string): string | undefined => p.nodes.find(n => n.id === id)?.status;
const sample: PlanInputNode[] = [
    { title: 'Read exporter' },
    { title: 'Write writer', children: [{ title: 'Header', children: [{ title: 'Quote' }] }, { title: 'Stream' }] },
    { title: 'Tests' },
];
test('setPlan assigns path ids 1, 1.1, 1.1.1 in tree order with parentId links', () => {
    const plan = ok(setPlan(emptyPlan(), 'CSV export', sample, 10));
    assert.equal(plan.title, 'CSV export');
    assert.deepEqual(ids(plan), ['1', '2', '2.1', '2.1.1', '2.2', '3']);
    assert.deepEqual(plan.nodes.map(n => n.parentId), [null, null, '2', '2.1', '2', null]);
    assert.equal(plan.nodes.every(n => n.source === 'plan' && n.updatedAt === 10), true);
});
test('add under a parent takes max sibling id + 1 and never reuses a removed id', () => {
    let plan = ok(setPlan(emptyPlan(), 'P', sample, 1));
    plan = ok(addNodes(plan, '2', [{ title: 'Flush' }], 2));
    assert.deepEqual(ids(plan), ['1', '2', '2.1', '2.1.1', '2.2', '2.3', '3']);
    plan = ok(removeNode(plan, '2.3', 3));
    plan = ok(addNodes(plan, '2', [{ title: 'Close' }], 4));
    assert.ok(ids(plan).includes('2.4'));
    assert.ok(!ids(plan).includes('2.3'));
    plan = ok(removeNode(plan, '3', 5));
    plan = ok(addNodes(plan, null, [{ title: 'Docs' }], 6));
    assert.deepEqual(ids(plan), ['1', '2', '2.1', '2.1.1', '2.2', '2.4', '4']);
});
test('update of an unknown id returns an error listing the valid ids, and changes nothing', () => {
    const plan = ok(setPlan(emptyPlan(), 'P', sample, 1));
    const message = err(updateNodes(plan, [{ id: '1', status: 'completed' }, { id: '9', status: 'completed' }], 2));
    assert.ok(message.includes('unknown id "9"'));
    assert.ok(message.includes('1, 2, 2.1, 2.1.1, 2.2, 3'));
    assert.equal(status(plan, '1'), 'pending');
});
test('update sets leaf status, title and note; an empty note clears it; a parent status is refused', () => {
    const plan = ok(setPlan(emptyPlan(), 'P', sample, 1));
    const next = ok(updateNodes(plan, [{ id: '1', status: 'blocked', note: 'flag name?', title: 'Read it' }], 5));
    const node = next.nodes.find(n => n.id === '1');
    assert.partialDeepStrictEqual(node, { status: 'blocked', note: 'flag name?', title: 'Read it', updatedAt: 5 });
    const cleared = ok(updateNodes(next, [{ id: '1', note: '' }], 6));
    assert.equal(cleared.nodes.find(n => n.id === '1')?.note, undefined);
    assert.ok(err(updateNodes(plan, [{ id: '2', status: 'completed' }], 2)).includes('has children'));
});
test('remove drops the subtree and reports an unknown id', () => {
    const plan = ok(setPlan(emptyPlan(), 'P', sample, 1));
    const next = ok(removeNode(plan, '2.1', 2));
    assert.deepEqual(ids(next), ['1', '2', '2.2', '3']);
    assert.ok(err(removeNode(plan, '7', 2)).includes('unknown id "7"'));
    assert.deepEqual(ids(ok(removeNode(plan, '2', 2))), ['1', '3']);
});
test('rollup: all completed or skipped completes, any in_progress wins, blocked needs none in_progress', () => {
    const base = ok(setPlan(emptyPlan(), 'P', [{ title: 'A', children: [{ title: 'a1' }, { title: 'a2' }] }], 1));
    assert.equal(status(base, '1'), 'pending');
    const done = ok(updateNodes(base, [{ id: '1.1', status: 'completed' }, { id: '1.2', status: 'skipped', note: 'n/a' }], 2));
    assert.equal(status(done, '1'), 'completed');
    const active = ok(updateNodes(base, [{ id: '1.1', status: 'blocked', note: 'x' }, { id: '1.2', status: 'in_progress' }], 2));
    assert.equal(status(active, '1'), 'in_progress');
    const blocked = ok(updateNodes(base, [{ id: '1.1', status: 'blocked', note: 'x' }], 2));
    assert.equal(status(blocked, '1'), 'blocked');
    const partial = ok(updateNodes(base, [{ id: '1.1', status: 'completed' }], 2));
    assert.equal(status(partial, '1'), 'in_progress');
});
test('rollup climbs more than one level and stamps updatedAt only on parents that changed', () => {
    const base = ok(setPlan(emptyPlan(), 'P', sample, 1));
    const next = ok(updateNodes(base, [{ id: '2.1.1', status: 'in_progress' }], 7));
    assert.equal(status(next, '2.1'), 'in_progress');
    assert.equal(status(next, '2'), 'in_progress');
    assert.equal(next.nodes.find(n => n.id === '2')?.updatedAt, 7);
    assert.equal(next.nodes.find(n => n.id === '3')?.updatedAt, 1);
    assert.deepEqual(rollup(next, 99), next);
});
test('limits: depth 3, 60 nodes, title 120 characters, note 200 characters', () => {
    const deep: PlanInputNode[] = [{ title: 'a', children: [{ title: 'b', children: [{ title: 'c', children: [{ title: 'd' }] }] }] }];
    assert.ok(err(setPlan(emptyPlan(), 'P', deep, 1)).includes('deeper than 3'));
    const base = ok(setPlan(emptyPlan(), 'P', sample, 1));
    assert.ok(err(addNodes(base, '2.1.1', [{ title: 'too deep' }], 2)).includes('deeper than 3'));
    const many = Array.from({ length: 61 }, (_, i) => ({ title: `n${i}` }));
    assert.ok(err(setPlan(emptyPlan(), 'P', many, 1)).includes('limit is 60'));
    const sixty = ok(setPlan(emptyPlan(), 'P', many.slice(0, 60), 1));
    assert.equal(sixty.nodes.length, 60);
    assert.ok(err(addNodes(sixty, null, [{ title: 'one more' }], 2)).includes('limit is 60'));
    assert.ok(err(setPlan(emptyPlan(), 'P', [{ title: 'x'.repeat(121) }], 1)).includes('limit is 120'));
    assert.ok(err(setPlan(emptyPlan(), 'x'.repeat(121), sample, 1)).includes('limit is 120'));
    assert.equal(ok(setPlan(emptyPlan(), 'P', [{ title: 'x'.repeat(120) }], 1)).nodes.length, 1);
    assert.ok(err(updateNodes(base, [{ id: '1', note: 'n'.repeat(201) }], 2)).includes('limit is 200'));
    assert.equal((ok(updateNodes(base, [{ id: '1', note: 'n'.repeat(200) }], 2)).nodes[0]?.note)?.length, 200);
});
test('a title containing an escape sequence is stored cleaned', () => {
    const plan = ok(setPlan(emptyPlan(), 'Plan\u001b[2J', [{ title: 'Wipe\u001b[2J screen', activeForm: 'Wiping‮' }], 1));
    assert.equal(plan.title, 'Plan [2J');
    assert.equal(plan.nodes[0]?.title, 'Wipe [2J screen');
    assert.equal(plan.nodes[0]?.activeForm, 'Wiping');
    const next = ok(updateNodes(plan, [{ id: '1', title: 'T\u001b[2J', note: 'N\u001b[2J' }], 2));
    assert.partialDeepStrictEqual(next.nodes[0], { title: 'T [2J', note: 'N [2J' });
});
test('every op returns an error instead of throwing on bad input', () => {
    const plan = ok(setPlan(emptyPlan(), 'P', sample, 1));
    assert.ok(err(setPlan(emptyPlan(), 'P', [], 1)).includes('no nodes'));
    assert.ok(err(setPlan(emptyPlan(), '  ', sample, 1)).includes('plan title is empty'));
    assert.ok(err(addNodes(plan, '8', [{ title: 'x' }], 2)).includes('unknown parent "8"'));
    assert.ok(err(updateNodes(plan, [{ id: '1', status: 'done' as 'completed' }], 2)).includes('unknown status'));
    const malformed = [{ title: 42 }] as unknown as PlanInputNode[]; // a runtime shape the types forbid
    assert.ok(err(setPlan(emptyPlan(), 'P', malformed, 1)).includes('must be text'));
    assert.notEqual(err(setPlan(emptyPlan(), 'P', undefined as unknown as PlanInputNode[], 1)), '');
});
test('set keeps todo and task nodes and numbers new top-level ids after them', () => {
    const kept: Plan = {
        title: 'old',
        nodes: [{ id: '1', parentId: null, title: 'from TodoWrite', status: 'pending', source: 'todo', updatedAt: 0 }],
        issued: [],
    };
    const plan = ok(setPlan(kept, 'New', [{ title: 'planned' }], 5));
    assert.deepEqual(plan.nodes.map(n => [n.id, n.source]), [['1', 'todo'], ['2', 'plan']]);
});
test('progress counts leaves, with skipped counted as done', () => {
    const base = ok(setPlan(emptyPlan(), 'P', sample, 1));
    assert.deepEqual(progress(base), { done: 0, total: 4 });
    const next = ok(updateNodes(base, [{ id: '1', status: 'completed' }, { id: '2.2', status: 'skipped', note: 'n/a' }], 2));
    assert.deepEqual(progress(next), { done: 2, total: 4 });
    assert.deepEqual(progress(emptyPlan()), { done: 0, total: 0 });
});
test('currentNode is the first in_progress leaf, else the first pending leaf, else null', () => {
    const base = ok(setPlan(emptyPlan(), 'P', sample, 1));
    assert.equal(currentNode(base)?.id, '1');
    const mid = ok(updateNodes(base, [{ id: '1', status: 'completed' }, { id: '2.2', status: 'in_progress' }], 2));
    assert.equal(currentNode(mid)?.id, '2.2');
    const next = ok(updateNodes(mid, [{ id: '2.2', status: 'completed' }], 3));
    assert.equal(currentNode(next)?.id, '2.1.1');
    const all = ok(updateNodes(next, [{ id: '2.1.1', status: 'completed' }, { id: '3', status: 'completed' }], 4));
    assert.equal(currentNode(all), null);
    assert.equal(currentNode(emptyPlan()), null);
});
test('hasUnfinished is true while a leaf is pending, in_progress or blocked', () => {
    const base = ok(setPlan(emptyPlan(), 'P', [{ title: 'A' }, { title: 'B' }], 1));
    assert.equal(hasUnfinished(base), true);
    const blocked = ok(updateNodes(base, [{ id: '1', status: 'completed' }, { id: '2', status: 'blocked', note: 'x' }], 2));
    assert.equal(hasUnfinished(blocked), true);
    const finished = ok(updateNodes(base, [{ id: '1', status: 'completed' }, { id: '2', status: 'skipped', note: 'n/a' }], 2));
    assert.equal(hasUnfinished(finished), false);
    assert.equal(hasUnfinished(emptyPlan()), false);
});
test('removing the last child resets the parent to pending instead of keeping its derived status', () => {
    const base = ok(setPlan(emptyPlan(), 'P', [{ title: 'A', children: [{ title: 'a1' }] }], 1));
    const done = ok(updateNodes(base, [{ id: '1.1', status: 'completed' }], 2));
    assert.equal(status(done, '1'), 'completed');
    const next = ok(removeNode(done, '1.1', 3));
    assert.equal(status(next, '1'), 'pending');
    assert.deepEqual(progress(next), { done: 0, total: 1 });
});
const par = (): Plan => ok(setPlan(emptyPlan(), 'P', [
    { title: 'Group', parallel: true, children: [{ title: 'A' }, { title: 'B' }] },
    { title: 'Seq', children: [{ title: 'C' }, { title: 'D' }] },
], 1));
const flag = (p: Plan, id: string): boolean | undefined => p.nodes.find(n => n.id === id)?.parallel;
test('parallel survives set, add and update, and false clears it', () => {
    let plan = par();
    assert.equal(flag(plan, '1'), true);
    assert.equal(flag(plan, '2'), undefined);
    plan = ok(addNodes(plan, null, [{ title: 'More', parallel: true, children: [{ title: 'X' }] }], 2));
    assert.equal(flag(plan, '3'), true);
    plan = ok(updateNodes(plan, [{ id: '2', parallel: true }], 3));
    assert.equal(flag(plan, '2'), true);
    plan = ok(updateNodes(plan, [{ id: '1', parallel: false }], 4));
    assert.equal(flag(plan, '1'), undefined);
});
test('parallel on a leaf is rejected in set, add and update', () => {
    assert.ok(err(setPlan(emptyPlan(), 'P', [{ title: 'Leaf', parallel: true }], 1)).includes('parallel'));
    assert.ok(err(addNodes(par(), null, [{ title: 'Leaf', parallel: true }], 2)).includes('parallel'));
    assert.ok(err(updateNodes(par(), [{ id: '1.1', parallel: true }], 2)).includes('parallel'));
});
test('two in_progress leaves under a parallel parent are allowed', () => {
    const plan = ok(updateNodes(par(), [{ id: '1.1', status: 'in_progress' }, { id: '1.2', status: 'in_progress' }], 2));
    assert.equal(status(plan, '1.1'), 'in_progress');
    assert.equal(status(plan, '1.2'), 'in_progress');
    assert.equal(validateConcurrency(plan), null);
});
test('two in_progress leaves across non-parallel branches are rejected naming both ids', () => {
    const message = err(updateNodes(par(), [{ id: '1.1', status: 'in_progress' }, { id: '2.1', status: 'in_progress' }], 2));
    assert.ok(message.includes('"1.1"'));
    assert.ok(message.includes('"2.1"'));
    assert.ok(message.includes('"parallel": true'));
    const sibling = err(updateNodes(par(), [{ id: '2.1', status: 'in_progress' }, { id: '2.2', status: 'in_progress' }], 2));
    assert.ok(sibling.includes('"2.1"'));
    assert.ok(sibling.includes('"2.2"'));
});
test('a parallel group inside a sequential parent does not allow a sibling leaf to run alongside', () => {
    const plan = ok(setPlan(emptyPlan(), 'P', [{ title: 'Seq', children: [{ title: 'Group', parallel: true, children: [{ title: 'A' }, { title: 'B' }] }, { title: 'Next' }] }], 1));
    const both = ok(updateNodes(plan, [{ id: '1.1.1', status: 'in_progress' }, { id: '1.1.2', status: 'in_progress' }], 2));
    assert.equal(validateConcurrency(both), null);
    const message = err(updateNodes(both, [{ id: '1.2', status: 'in_progress' }], 3));
    assert.ok(message.includes('"1.2"'));
});
test('activeLeaves returns every in_progress leaf in tree order and skips parents', () => {
    assert.deepEqual(activeLeaves(par()), []);
    const set = ok(updateNodes(par(), [{ id: '1.2', status: 'in_progress' }, { id: '1.1', status: 'in_progress' }], 2));
    assert.deepEqual(activeLeaves(set).map(n => n.id), ['1.1', '1.2']);
    assert.equal(currentNode(set)?.id, '1.1');
});
test('clearing parallel while two children are in_progress is rejected and leaves the plan untouched', () => {
    const running = ok(updateNodes(par(), [{ id: '1.1', status: 'in_progress' }, { id: '1.2', status: 'in_progress' }], 2));
    const message = err(updateNodes(running, [{ id: '1', parallel: false }], 3));
    assert.ok(message.includes('"1.1"'));
    assert.equal(flag(running, '1'), true);
});
test('removing the last child of a parallel parent clears its parallel flag', () => {
    let plan = ok(removeNode(par(), '1.1', 2));
    assert.equal(flag(plan, '1'), true);
    plan = ok(removeNode(plan, '1.2', 3));
    assert.equal(flag(plan, '1'), undefined);
});
