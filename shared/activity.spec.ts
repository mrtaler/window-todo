import { test } from "node:test";
import assert from "node:assert/strict";
import { activityLabel, emptyActivity, reduceActivity } from './activity';
import type { ActivityEvent, ActivityState } from './activity';
// Runs events in order, one tick apart, from idle at t=0.
const run = (events: ActivityEvent[], start: ActivityState = emptyActivity(0)): ActivityState => events.reduce((s, e, i) => reduceActivity(s, e, i + 1), start);
test('turnStart goes working; turnComplete answer goes idle', () => {
    assert.equal(run([{ type: 'turnStart' }]).phase, 'working');
    assert.equal(run([{ type: 'turnStart' }, { type: 'turnComplete', reason: 'answer' }]).phase, 'idle');
});
test('turnComplete maps aborted to interrupted and error/refusal to error', () => {
    assert.equal(run([{ type: 'turnStart' }, { type: 'turnComplete', reason: 'aborted' }]).phase, 'interrupted');
    assert.equal(run([{ type: 'turnStart' }, { type: 'turnComplete', reason: 'error' }]).phase, 'error');
    assert.equal(run([{ type: 'turnStart' }, { type: 'turnComplete', reason: 'refusal' }]).phase, 'error');
});
test('a rejected dialog ends the turn as answer: idle, not interrupted', () => {
    const s = run([
        { type: 'turnStart' },
        { type: 'toolStart', tool: 'Write' },
        { type: 'permissionAsk', tool: 'Write' },
        { type: 'turnComplete', reason: 'answer' },
    ]);
    assert.equal(s.phase, 'idle');
});
test('turnComplete carrying an agentId leaves activity unchanged', () => {
    const working = run([{ type: 'turnStart' }]);
    assert.equal(reduceActivity(working, { type: 'turnComplete', reason: 'answer', agentId: 'a1' }, 9), working);
    assert.equal(reduceActivity(working, { type: 'turnComplete', reason: 'error', agentId: 'a1' }, 9), working);
});
test('toolStart shows the tool; toolEnd returns to working', () => {
    const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash' }]);
    assert.equal(s.phase, 'tool');
    assert.equal(s.tool, 'Bash');
    assert.equal(run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash' }, { type: 'toolEnd' }]).phase, 'working');
});
test('permission during a tool shows permission; toolEnd returns to working', () => {
    const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Write' }, { type: 'permissionAsk', tool: 'Write' }]);
    assert.equal(s.phase, 'permission');
    assert.equal(activityLabel(s), 'Waiting for permission: Write');
    assert.equal(reduceActivity(s, { type: 'toolEnd' }, 9).phase, 'working');
});
test('permissionEnd leaves permission for working and changes no other phase', () => {
    const p = run([{ type: 'turnStart' }, { type: 'permissionAsk', tool: 'Bash' }]);
    assert.equal(reduceActivity(p, { type: 'permissionEnd' }, 9).phase, 'working');
    const t = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash' }]);
    assert.equal(reduceActivity(t, { type: 'permissionEnd' }, 9), t);
});
test('question outranks permission, compacting and tool; questionClose returns to working', () => {
    const q = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'AskUserQuestion' }, { type: 'questionOpen' }]);
    assert.equal(q.phase, 'question');
    // Lower phases do not override a question.
    assert.equal(reduceActivity(q, { type: 'permissionAsk', tool: 'X' }, 9), q);
    assert.equal(reduceActivity(q, { type: 'compactStart' }, 9), q);
    // A call started under a higher phase is tracked; the visible fields do not move.
    assert.deepEqual(reduceActivity(q, { type: 'toolStart', tool: 'X' }, 9), {
        ...q,
        running: [...q.running, { id: 'name:X', tool: 'X' }],
    });
    // A toolEnd drops the running call but does not move the phase.
    assert.deepEqual(reduceActivity(q, { type: 'toolEnd' }, 9), { ...q, running: [] });
    // The AskUserQuestion entry is still running (T07 removes it by id), so the phase settles into tool.
    const closed = reduceActivity(q, { type: 'questionClose' }, 9);
    assert.equal(closed.phase, 'tool');
    assert.equal(closed.tool, 'AskUserQuestion');
    assert.equal(reduceActivity(reduceActivity(q, { type: 'toolEnd' }, 9), { type: 'questionClose' }, 9).phase, 'working');
});
test('permission outranks compacting and tool', () => {
    const p = run([{ type: 'turnStart' }, { type: 'permissionAsk', tool: 'Bash' }]);
    assert.equal(reduceActivity(p, { type: 'compactStart' }, 9), p);
    assert.deepEqual(reduceActivity(p, { type: 'toolStart', tool: 'Read' }, 9), { ...p, running: [{ id: 'name:Read', tool: 'Read' }] });
});
test('compacting outranks tool; compactEnd returns to working', () => {
    const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash' }, { type: 'compactStart' }]);
    assert.equal(s.phase, 'compacting');
    assert.equal(activityLabel(s), 'Compacting');
    assert.deepEqual(reduceActivity(s, { type: 'toolStart', tool: 'Read' }, 9), {
        ...s,
        running: [...s.running, { id: 'name:Read', tool: 'Read' }],
    });
    // Bash is still running, so compactEnd settles into tool; with none left it is working.
    const ended = reduceActivity(s, { type: 'compactEnd' }, 9);
    assert.equal(ended.phase, 'tool');
    assert.equal(ended.tool, 'Bash');
    assert.equal(reduceActivity(reduceActivity(s, { type: 'toolEnd' }, 9), { type: 'compactEnd' }, 9).phase, 'working');
});
test('stopFailure goes to error with a cleaned detail', () => {
    const s = run([{ type: 'turnStart' }, { type: 'stopFailure', detail: 'rate\u001b[2J limit' }]);
    assert.equal(s.phase, 'error');
    assert.equal(activityLabel(s), 'Error: rate [2J limit');
});
test('sessionClear resets activity, including subagents', () => {
    const s = run([{ type: 'turnStart' }, { type: 'subagentStart', id: 'a' }, { type: 'sessionClear' }]);
    assert.equal(s.phase, 'idle');
    assert.deepEqual(s.subagents, []);
    assert.equal(s.tool, undefined);
});
test('subagent ids form a set: duplicate start counts once, unknown stop is a no-op', () => {
    const s = run([
        { type: 'subagentStart', id: 'a' },
        { type: 'subagentStart', id: 'a' },
        { type: 'subagentStart', id: 'b' },
    ]);
    assert.deepEqual(s.subagents, ['a', 'b']);
    assert.equal(reduceActivity(s, { type: 'subagentStop', id: 'zzz' }, 9), s);
    assert.deepEqual(reduceActivity(s, { type: 'subagentStop', id: 'a' }, 9).subagents, ['b']);
});
test('Start/Stop from an unrelated background agent keeps the set consistent', () => {
    // Stop arrives before its Start (unknown), then a late Start and Stop pair up cleanly.
    const s = run([
        { type: 'subagentStop', id: 'bg' },
        { type: 'subagentStart', id: 'x' },
        { type: 'subagentStart', id: 'bg' },
        { type: 'subagentStop', id: 'bg' },
        { type: 'subagentStop', id: 'bg' },
    ]);
    assert.deepEqual(s.subagents, ['x']);
});
test('activityLabel covers each phase and the subagent suffix', () => {
    const base = emptyActivity(0);
    assert.equal(activityLabel(base), undefined);
    assert.equal(activityLabel({ ...base, phase: 'working' }), 'Working');
    assert.equal(activityLabel({ ...base, phase: 'tool', tool: 'Bash' }), 'Running Bash');
    assert.equal(activityLabel({ ...base, phase: 'permission', tool: 'Edit' }), 'Waiting for permission: Edit');
    assert.equal(activityLabel({ ...base, phase: 'question' }), 'Waiting for your answer');
    assert.equal(activityLabel({ ...base, phase: 'compacting' }), 'Compacting');
    assert.equal(activityLabel({ ...base, phase: 'interrupted' }), 'Interrupted');
    assert.equal(activityLabel({ ...base, phase: 'error', detail: 'boom' }), 'Error: boom');
    assert.equal(activityLabel({ ...base, phase: 'working', subagents: ['a'] }), 'Working · 1 subagent');
    assert.equal(activityLabel({ ...base, phase: 'working', subagents: ['a', 'b'] }), 'Working · 2 subagents');
});
test('model-supplied strings are cleaned', () => {
    const s = run([{ type: 'toolStart', tool: 'Ba‮sh\u001b[2J' }]);
    assert.equal(s.tool, 'Bash [2J');
    assert.deepEqual(run([{ type: 'subagentStart', id: 'a\u001bb' }]).subagents, ['a b']);
});
test('since changes only when the phase changes', () => {
    const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'A' }]);
    assert.equal(s.since, 2);
    assert.equal(reduceActivity(s, { type: 'toolStart', tool: 'B' }, 9).since, 2);
});
test('compactEnd restores the phase active before compactStart', () => {
    const end = (s: ActivityState) => reduceActivity(s, { type: 'compactEnd' }, 9);
    const idle = run([{ type: 'compactStart' }]);
    assert.equal(idle.phase, 'compacting');
    assert.equal(end(idle).phase, 'idle');
    assert.equal(activityLabel(end(idle)), undefined);
    assert.equal(end(run([{ type: 'turnStart' }, { type: 'compactStart' }])).phase, 'working');
    // A repeated compactStart keeps the first resume phase.
    assert.equal(end(run([{ type: 'compactStart' }, { type: 'compactStart' }])).phase, 'idle');
});
const twoCalls: ActivityEvent[] = [
    { type: 'turnStart' },
    { type: 'toolStart', tool: 'Read', id: 'r1' },
    { type: 'toolStart', tool: 'Bash', id: 'b1' },
];
test('two starts and one end by id keep the tool phase and show the other call', () => {
    const s = run([...twoCalls, { type: 'toolEnd', id: 'r1' }]);
    assert.equal(s.phase, 'tool');
    assert.equal(s.tool, 'Bash');
    assert.deepEqual(s.running, [{ id: 'b1', tool: 'Bash' }]);
});
test('ending the newest call reverts the label to the older one; ending the last gives working', () => {
    const older = run([...twoCalls, { type: 'toolEnd', id: 'b1' }]);
    assert.equal(older.phase, 'tool');
    assert.equal(older.tool, 'Read');
    const none = reduceActivity(older, { type: 'toolEnd', id: 'r1' }, 9);
    assert.equal(none.phase, 'working');
    assert.deepEqual(none.running, []);
});
test('toolEnd with an unknown id and no matching synthetic entry is a no-op', () => {
    const s = run(twoCalls);
    assert.equal(reduceActivity(s, { type: 'toolEnd', id: 'zzz' }, 9), s);
    assert.equal(reduceActivity(s, { type: 'toolEnd', id: 'zzz', tool: 'Bash' }, 9), s);
});
test('the name fallback removes only the oldest synthetic entry of that tool', () => {
    const s = run([
        { type: 'turnStart' },
        { type: 'toolStart', tool: 'Bash', id: 'b1' },
        { type: 'toolStart', tool: 'Bash' },
        { type: 'toolStart', tool: 'Bash' },
    ]);
    assert.deepEqual(s.running.map(r => r.id), ['b1', 'name:Bash', 'name:Bash']);
    const one = reduceActivity(s, { type: 'toolEnd', tool: 'Bash' }, 9);
    assert.deepEqual(one.running.map(r => r.id), ['b1', 'name:Bash']);
    const two = reduceActivity(one, { type: 'toolEnd', id: 'unknown', tool: 'Bash' }, 9);
    assert.deepEqual(two.running.map(r => r.id), ['b1']);
    // An end carrying an unknown id never removes an id-bearing entry by name.
    assert.equal(reduceActivity(two, { type: 'toolEnd', id: 'unknown', tool: 'Bash' }, 9), two);
});
test('toolEnd with a tool but no id clears a real-id entry of that tool', () => {
    const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash', id: 'b1' }]);
    const ended = reduceActivity(s, { type: 'toolEnd', tool: 'Bash' }, 9);
    assert.deepEqual(ended.running, []);
    assert.equal(ended.phase, 'working');
});
test('another call ending keeps a pending permission wait; the asking call ending settles it', () => {
    const s = run([
        { type: 'turnStart' },
        { type: 'toolStart', tool: 'Write', id: 'a' },
        { type: 'toolStart', tool: 'Read', id: 'b' },
        { type: 'permissionAsk', tool: 'Write' },
    ]);
    const other = reduceActivity(s, { type: 'toolEnd', id: 'b', tool: 'Read' }, 9);
    assert.equal(other.phase, 'permission');
    assert.equal(other.tool, 'Write');
    assert.deepEqual(other.running, [{ id: 'a', tool: 'Write' }]);
    const own = reduceActivity(other, { type: 'toolEnd', id: 'a', tool: 'Write' }, 10);
    assert.equal(own.phase, 'working');
});
test('a stored activity value without running or subagents is treated as empty', () => {
    const legacy = { phase: 'working', since: 0 } as unknown as ActivityState; // pre-reload shape lacks the arrays
    const started = reduceActivity(legacy, { type: 'toolStart', tool: 'Bash', id: 'a' }, 1);
    assert.deepEqual(started.running, [{ id: 'a', tool: 'Bash' }]);
    assert.equal(reduceActivity(legacy, { type: 'toolEnd', id: 'a' }, 1).phase, 'working');
    assert.deepEqual(reduceActivity(legacy, { type: 'subagentStart', id: 's' }, 1).subagents, ['s']);
});
test('toolEnd with neither id nor tool clears every running call', () => {
    const s = run([...twoCalls, { type: 'toolEnd' }]);
    assert.deepEqual(s.running, []);
    assert.equal(s.phase, 'working');
});
test('turnStart, turnComplete and sessionClear empty running; a subagent turn end keeps it', () => {
    const s = run(twoCalls);
    assert.deepEqual(reduceActivity(s, { type: 'turnStart' }, 9).running, []);
    assert.deepEqual(reduceActivity(s, { type: 'turnComplete', reason: 'answer' }, 9).running, []);
    assert.deepEqual(reduceActivity(s, { type: 'turnComplete', reason: 'aborted' }, 9).running, []);
    assert.deepEqual(reduceActivity(s, { type: 'sessionClear' }, 9).running, []);
    assert.equal(reduceActivity(s, { type: 'turnComplete', reason: 'answer', agentId: 'a' }, 9), s);
});
test('a call started under permission stays tracked: ending the first leaves tool with the second, not working', () => {
    const s = run([
        { type: 'turnStart' },
        { type: 'toolStart', tool: 'Write', id: 'a' },
        { type: 'permissionAsk', tool: 'Write' },
        { type: 'toolStart', tool: 'Read', id: 'b' },
    ]);
    assert.equal(s.phase, 'permission');
    assert.equal(s.tool, 'Write');
    assert.deepEqual(s.running.map(r => r.id), ['a', 'b']);
    const after = reduceActivity(s, { type: 'toolEnd', id: 'a' }, 9);
    assert.equal(after.phase, 'tool');
    assert.equal(after.tool, 'Read');
    assert.deepEqual(after.running, [{ id: 'b', tool: 'Read' }]);
});
test('permissionEnd with a call still running settles into tool with that call, not working', () => {
    const s = run([
        { type: 'turnStart' },
        { type: 'toolStart', tool: 'Write', id: 'a' },
        { type: 'permissionAsk', tool: 'Write' },
        { type: 'toolStart', tool: 'Read', id: 'b' },
    ]);
    const ended = reduceActivity(s, { type: 'permissionEnd' }, 9);
    assert.equal(ended.phase, 'tool');
    assert.equal(ended.tool, 'Read');
    const bare = run([{ type: 'turnStart' }, { type: 'permissionAsk', tool: 'Write' }, { type: 'permissionEnd' }]);
    assert.equal(bare.phase, 'working');
});
test('compactEnd with a call still running settles into tool with that call, not working', () => {
    const s = run([
        { type: 'turnStart' },
        { type: 'toolStart', tool: 'Bash', id: 'a' },
        { type: 'compactStart' },
        { type: 'toolStart', tool: 'Read', id: 'b' },
    ]);
    const ended = reduceActivity(s, { type: 'compactEnd' }, 9);
    assert.equal(ended.phase, 'tool');
    assert.equal(ended.tool, 'Read');
});
