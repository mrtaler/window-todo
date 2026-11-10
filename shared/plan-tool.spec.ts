import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyPlan, setPlan } from './plan';
import type { Plan } from './plan';
import { applyPlanOp, formatForModel, parsePlanInput, PLAN_INPUT_SCHEMA, PLAN_TOOL_DESCRIPTION, PLAN_TOOL_SHORT_NAME, touchesPlan } from './plan-tool';
import type { PlanOp } from './plan-tool';
const parsed = (raw: unknown): PlanOp => {
    const r = parsePlanInput(raw);
    if ('error' in r)
        throw new Error(`expected an op, got ${r.error}`);
    return r.parsed;
};
const errorOf = (raw: unknown): string => {
    const r = parsePlanInput(raw);
    if ('parsed' in r)
        throw new Error('expected an error');
    return r.error;
};
const built = (r: ReturnType<typeof setPlan>): Plan => {
    if ('error' in r)
        throw new Error(r.error);
    return r.plan;
};
const realistic: Record<string, unknown> = {
    set: {
        op: 'set',
        title: 'CSV export',
        nodes: [{ title: 'Read exporter', activeForm: 'Reading exporter' }, { title: 'Write writer', children: [{ title: 'Header' }, { title: 'Quote', children: [{ title: 'Commas' }] }] }],
    },
    add: { op: 'add', parent: '2', nodes: [{ title: 'Stream' }] },
    update: { op: 'update', updates: [{ id: '1', status: 'completed' }, { id: '2.1', status: 'blocked', note: 'flag name?' }] },
    remove: { op: 'remove', id: '2.1' },
    show: { op: 'show' },
};
test('each op parses from a realistic raw object', () => {
    assert.equal(PLAN_TOOL_SHORT_NAME, 'plan');
    assert.deepEqual(parsed(realistic.set), {
        op: 'set',
        title: 'CSV export',
        nodes: [{ title: 'Read exporter', activeForm: 'Reading exporter' }, { title: 'Write writer', children: [{ title: 'Header' }, { title: 'Quote', children: [{ title: 'Commas' }] }] }],
    });
    assert.deepEqual(parsed(realistic.add), { op: 'add', parent: '2', nodes: [{ title: 'Stream' }] });
    assert.deepEqual(parsed({ op: 'add', nodes: [{ title: 'Top' }] }), { op: 'add', parent: null, nodes: [{ title: 'Top' }] });
    assert.deepEqual(parsed(realistic.update), {
        op: 'update',
        updates: [{ id: '1', status: 'completed' }, { id: '2.1', status: 'blocked', note: 'flag name?' }],
    });
    assert.deepEqual(parsed(realistic.remove), { op: 'remove', id: '2.1' });
    assert.deepEqual(parsed(realistic.show), { op: 'show' });
});
test('the schema op enum equals the ops the parser accepts', () => {
    const props = PLAN_INPUT_SCHEMA.properties as Record<string, {
        enum?: string[];
    }>;
    const schemaOps = props.op?.enum ?? [];
    assert.deepEqual([...schemaOps].sort(), Object.keys(realistic).sort());
    for (const op of schemaOps)
        assert.equal(parsed(realistic[op]).op, op);
    assert.ok(errorOf({ op: 'rename' }).includes('unknown op "rename"'));
});
test('the schema nests children to depth 3 without $ref', () => {
    const text = JSON.stringify(PLAN_INPUT_SCHEMA);
    assert.equal(text.includes('$ref'), false);
    const props = PLAN_INPUT_SCHEMA.properties as Record<string, {
        items?: Record<string, unknown>;
    }>;
    let level = props.nodes?.items;
    let depth = 0;
    while (level !== undefined) {
        depth++;
        const kids = (level.properties as Record<string, {
            items?: Record<string, unknown>;
        }>).children;
        level = kids?.items;
    }
    assert.equal(depth, 3);
});
test('the description is 3 to 6 sentences covering the plan rules', () => {
    const sentences = PLAN_TOOL_DESCRIPTION.split(/(?<=\.)\s+/);
    assert.equal(sentences.length >= 3 && sentences.length <= 6, true);
    for (const word of ['set', 'in_progress', 'completed', 'blocked', 'skipped', 'note', 'add'])
        assert.ok(PLAN_TOOL_DESCRIPTION.includes(word));
});
test('missing op, a wrong-typed field and depth 4 each give a specific error', () => {
    assert.equal(errorOf({ title: 'x', nodes: [] }), 'Error: missing "op"; use one of set, add, update, remove, show');
    assert.ok(errorOf('set').includes('got a string'));
    assert.equal(errorOf({ op: 'set', title: 'T', nodes: [{ title: 5 }] }), 'Error: nodes[0].title must be a string, got a number');
    assert.ok(errorOf({ op: 'update', updates: [{ id: '1', status: 'done' }] }).includes('updates[0].status "done" is unknown'));
    assert.equal(errorOf({ op: 'remove', id: 3 }), 'Error: op remove needs an "id" string, got a number');
    const deep = { title: 'a', children: [{ title: 'b', children: [{ title: 'c', children: [{ title: 'd' }] }] }] };
    assert.ok(errorOf({ op: 'set', title: 'T', nodes: [deep] }).includes('nodes[0].children[0].children[0].children is too deep'));
    assert.ok(errorOf({ op: 'add', parent: '1.2', nodes: [{ title: 'x', children: [{ title: 'y' }] }] }).includes('too deep'));
    assert.ok(errorOf({ op: 'add', parent: '1.2.3', nodes: [{ title: 'x' }] }).includes('already at depth 3'));
});
test('formatForModel lists every id and status word with no ANSI and a header', () => {
    const plan = built(setPlan(emptyPlan(), 'CSV export', [{ title: 'Read' }, { title: 'Write', children: [{ title: 'Header' }, { title: 'Quote' }] }], 1));
    const done = applyPlanOp(plan, parsed({ op: 'update', updates: [{ id: '1', status: 'completed' }, { id: '2.1', status: 'in_progress' }, { id: '2.2', status: 'skipped', note: 'n/a' }] }), 2);
    if ('error' in done)
        throw new Error(done.error);
    const text = formatForModel(done.plan);
    const blocked = applyPlanOp(done.plan, parsed({ op: 'update', updates: [{ id: '2.1', status: 'blocked', note: 'why' }] }), 3);
    if ('error' in blocked)
        throw new Error(blocked.error);
    assert.ok(formatForModel(blocked.plan).includes('[blocked] Header (why)'));
    for (const id of ['1', '2', '2.1', '2.2'])
        assert.ok(text.includes(`${id} [`));
    for (const word of ['completed', 'in_progress', 'skipped'])
        assert.ok(text.includes(`[${word}]`));
    assert.ok(text.includes('Plan: CSV export (2/3 done)'));
    assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text), false);
    assert.ok(formatForModel(emptyPlan()).includes('No plan yet'));
});
test('formatForModel strips ANSI from titles and caps output at 4000 chars', () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({ title: `\u001b[31mStep ${i} ${'x'.repeat(100)}` }));
    const plan = built(setPlan(emptyPlan(), 'Big', nodes, 1));
    const text = formatForModel(plan);
    assert.equal(text.length <= 4000, true);
    assert.equal(text.includes('\u001b'), false);
    assert.ok(text.includes('more nodes not shown'));
    assert.ok(text.includes('1 [pending]'));
});
test('applyPlanOp runs set, add, update, remove and show against the plan', () => {
    const empty = emptyPlan();
    const set = applyPlanOp(empty, parsed(realistic.set), 5);
    if ('error' in set)
        throw new Error(set.error);
    assert.deepEqual(set.plan.nodes.map(n => n.id), ['1', '2', '2.1', '2.2', '2.2.1']);
    assert.ok(set.text.includes('Plan: CSV export'));
    const add = applyPlanOp(set.plan, parsed(realistic.add), 6);
    if ('error' in add)
        throw new Error(add.error);
    assert.equal(add.plan.nodes.some(n => n.id === '2.3'), true);
    const upd = applyPlanOp(add.plan, parsed(realistic.update), 7);
    if ('error' in upd)
        throw new Error(upd.error);
    assert.equal(upd.plan.nodes.find(n => n.id === '2.1')?.status, 'blocked');
    assert.ok(upd.text.includes('2.1 [blocked] Header (flag name?)'));
    const rem = applyPlanOp(upd.plan, parsed(realistic.remove), 8);
    if ('error' in rem)
        throw new Error(rem.error);
    assert.equal(rem.plan.nodes.some(n => n.id === '2.1'), false);
    const show = applyPlanOp(rem.plan, parsed(realistic.show), 9);
    if ('error' in show)
        throw new Error(show.error);
    assert.equal(show.plan, rem.plan);
    assert.equal(show.text, formatForModel(rem.plan));
});
test('applyPlanOp returns Error-prefixed text for a rejected op and leaves the caller plan untouched', () => {
    const plan = built(setPlan(emptyPlan(), 'T', [{ title: 'A' }], 1));
    const r = applyPlanOp(plan, parsed({ op: 'remove', id: '9' }), 2);
    assert.equal('error' in r && r.error.startsWith('Error: unknown id "9"'), true);
    assert.equal(plan.nodes.length, 1);
    const dup = applyPlanOp(plan, parsed({ op: 'update', updates: [{ id: '1', status: 'completed' }, { id: '7', note: 'x' }] }), 3);
    assert.equal('error' in dup, true);
    assert.equal(plan.nodes[0]?.status, 'pending');
});
test('formatForModel never cuts a node line in half, at any plan size', () => {
    for (let n = 1; n <= 60; n++) {
        const nodes = Array.from({ length: n }, (_, i) => ({ title: `S${i}${'x'.repeat(100)}` }));
        const text = formatForModel(built(setPlan(emptyPlan(), 'Big', nodes, 1)));
        assert.equal(text.length <= 4000, true);
        for (const line of text.split('\n').slice(1))
            assert.equal(/^\d+ \[pending\] S\d+x{100}$|^\.\.\. \d+ more nodes not shown/.test(line), true);
    }
});
test('formatForModel keeps a long final line whole instead of slicing it', () => {
    for (let len = 40; len <= 120; len += 3) {
        for (let n = 2; n <= 60; n++) {
            const nodes = Array.from({ length: n }, (_, i) => ({ title: i === n - 1 ? 'y'.repeat(120) : `${'x'.repeat(len)}` }));
            const text = formatForModel(built(setPlan(emptyPlan(), 'Big', nodes, 1)));
            assert.equal(text.length <= 4000, true);
            for (const line of text.split('\n').slice(1))
                assert.equal(/^\d+ \[pending\] (x+|y{120})$|^\.\.\. \d+ more nodes not shown/.test(line), true);
        }
    }
});
test('touchesPlan is false for show and true for every op that writes the plan', () => {
    assert.equal(touchesPlan(parsed({ op: 'show' })), false);
    assert.equal(touchesPlan(parsed({ op: 'set', title: 'T', nodes: [{ title: 'A' }] })), true);
    assert.equal(touchesPlan(parsed({ op: 'add', nodes: [{ title: 'A' }] })), true);
    assert.equal(touchesPlan(parsed({ op: 'update', updates: [{ id: '1', status: 'completed' }] })), true);
    assert.equal(touchesPlan(parsed({ op: 'remove', id: '1' })), true);
});
test('parallel parses at depth 1 to 3 and in updates', () => {
    const nodes = [{ title: 'A', parallel: true, children: [{ title: 'B', parallel: false, children: [{ title: 'C' }] }] }];
    const r = parsePlanInput({ op: 'set', title: 'P', nodes });
    if (!('parsed' in r) || r.parsed.op !== 'set')
        throw new Error('expected a parsed set');
    assert.equal(r.parsed.nodes[0]?.parallel, true);
    assert.equal(r.parsed.nodes[0]?.children?.[0]?.parallel, false);
    const u = parsePlanInput({ op: 'update', updates: [{ id: '1', parallel: true }] });
    if (!('parsed' in u) || u.parsed.op !== 'update')
        throw new Error('expected a parsed update');
    assert.equal(u.parsed.updates[0]?.parallel, true);
});
test('a non-boolean parallel gives an error naming the field', () => {
    const a = parsePlanInput({ op: 'set', title: 'P', nodes: [{ title: 'A', children: [{ title: 'B', parallel: 'yes' }] }] });
    assert.ok('error' in a);
    assert.ok(a.error.includes('nodes[0].children[0].parallel must be a boolean'));
    const b = parsePlanInput({ op: 'update', updates: [{ id: '1', parallel: 1 }] });
    assert.ok('error' in b);
    assert.ok(b.error.includes('updates[0].parallel must be a boolean'));
});
test('formatForModel marks a parallel parent and the schema offers parallel at every depth', () => {
    const plan = setPlan(emptyPlan(), 'P', [{ title: 'Group', parallel: true, children: [{ title: 'A' }, { title: 'B' }] }], 1);
    if ('error' in plan)
        throw new Error(plan.error);
    assert.ok(formatForModel(plan.plan).includes('1 [pending] Group [parallel]'));
    assert.ok(!formatForModel(plan.plan).includes('1.1 [pending] A [parallel]'));
    assert.equal(JSON.stringify(PLAN_INPUT_SCHEMA).split('"parallel"').length - 1, 4);
});
