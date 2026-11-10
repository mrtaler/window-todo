import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivityState, Plan, PlanNode, PlanStatus } from './types';
import type { Seg, TreeLine } from './tree';
import { buildTree, DEFAULT_ACCENT, GLYPHS, paneRows, preferredRows, statusLine } from './tree';
const node = (id: string, status: PlanStatus, extra: Partial<PlanNode> = {}): PlanNode => {
    const parts = id.split('.');
    return {
        id,
        parentId: parts.length === 1 ? null : parts.slice(0, -1).join('.'),
        title: `T${id}`,
        status,
        source: 'plan',
        updatedAt: 0,
        ...extra,
    };
};
const planOf = (...nodes: PlanNode[]): Plan => ({ title: 'Add CSV', nodes, issued: [] });
const idle: ActivityState = { phase: 'idle', subagents: [], running: [], since: 0 };
const texts = (lines: {
    text: string;
}[]): string[] => lines.map(l => l.text);
// 2 levels: a completed branch, an active branch with a blocked and last child, a pending leaf.
const twoLevel = planOf(node('1', 'completed'), node('1.1', 'completed'), node('1.2', 'completed'), node('2', 'in_progress'), node('2.1', 'completed'), node('2.2', 'in_progress'), node('2.3', 'blocked', { note: 'flag name?' }), node('3', 'pending'));
// A row padded so `count` ends at the right edge of a pane `width` cells wide.
const padded = (left: string, count: string, width = 56): string => `${left}${' '.repeat(width - left.length - count.length)}${count}`;
const find = (lines: TreeLine[], needle: string): TreeLine => {
    const hit = lines.find(l => l.text.includes(needle));
    if (hit === undefined)
        throw new Error(`no row contains ${needle}`);
    return hit;
};
const segOf = (line: TreeLine, needle: string): Seg => {
    const hit = line.segments.find(s => s.text.includes(needle));
    if (hit === undefined)
        throw new Error(`no segment contains ${needle}`);
    return hit;
};
const toolActivity: ActivityState = { phase: 'tool', tool: 'Bash', subagents: ['a'], running: [], since: 0 };
test('buildTree draws exact lines for a 2-level fixture at width 56', () => {
    const lines = buildTree(twoLevel, toolActivity, { maxLines: 20, width: 56 });
    assert.deepEqual(texts(lines), [
        'Add CSV',
        `${'━'.repeat(20)}${'─'.repeat(20)}  3/6 · 50%`,
        '◉ Running Bash · 1 subagent',
        '',
        padded('├─ ✓ 1 T1', '2/2'),
        padded('├─ ◉ 2 T2', '1/3'),
        '│  ├─ ✓ 2.1 T2.1',
        '│  ├─ ◉ 2.2 T2.2 ◂',
        '│  └─ ■ 2.3 T2.3 (blocked: flag name?)',
        '└─ ○ 3 T3',
    ]);
});
test('the current row has an accent, bold title and a dim marker, with no inverse or background', () => {
    const lines = buildTree(twoLevel, idle, { maxLines: 20 });
    const row = find(lines, '2.2 T2.2');
    assert.partialDeepStrictEqual(segOf(row, 'T2.2'), { color: DEFAULT_ACCENT, bold: true, dim: false });
    assert.partialDeepStrictEqual(segOf(row, '◂'), { dim: true });
    assert.partialDeepStrictEqual(segOf(row, '◉'), { color: DEFAULT_ACCENT });
    for (const line of lines) {
        for (const s of line.segments) {
            assert.equal('inverse' in s, false);
            assert.equal('backgroundColor' in s, false);
        }
    }
});
test('leaf statuses get their glyph colour and title style', () => {
    const lines = buildTree(twoLevel, idle, { maxLines: 20 });
    assert.partialDeepStrictEqual(segOf(find(lines, '2.1 T2.1'), '✓'), { color: 'green' });
    assert.partialDeepStrictEqual(segOf(find(lines, '2.1 T2.1'), 'T2.1'), { dim: true });
    assert.partialDeepStrictEqual(segOf(find(lines, '2.3 T2.3'), '■'), { color: 'yellow' });
    assert.partialDeepStrictEqual(segOf(find(lines, '2.3 T2.3'), '(blocked: flag name?)'), { dim: true });
    assert.partialDeepStrictEqual(segOf(find(lines, '3 T3'), 'T3'), { bold: false, dim: false });
    const skipped = buildTree(planOf(node('1', 'skipped'), node('2', 'pending')), idle, { maxLines: 20 });
    assert.partialDeepStrictEqual(segOf(find(skipped, '1 T1'), 'T1'), { dim: true, strikethrough: true });
    assert.partialDeepStrictEqual(segOf(find(skipped, '1 T1'), '–'), { dim: true });
});
test('a parent title is bold and never the accent colour', () => {
    const lines = buildTree(twoLevel, idle, { maxLines: 20, accent: 'magenta' });
    const title = segOf(find(lines, '2 T2'), 'T2');
    assert.equal(title.bold, true);
    assert.equal(title.color, undefined);
    assert.equal(title.dim, false);
});
test('connectors and ids are dim', () => {
    const lines = buildTree(twoLevel, idle, { maxLines: 20 });
    const row = find(lines, '2.3 T2.3');
    assert.partialDeepStrictEqual(row.segments[0], { text: '│  └─ ', dim: true });
    assert.partialDeepStrictEqual(segOf(row, '2.3'), { dim: true });
    assert.partialDeepStrictEqual(segOf(find(lines, '3 T3'), '└─'), { dim: true });
});
test('parent counts sit dim at the right edge of the given width', () => {
    for (const width of [56, 60]) {
        const lines = buildTree(twoLevel, idle, { maxLines: 20, width });
        const row = find(lines, '2 T2');
        assert.equal(row.text.length, width);
        assert.equal(row.text.endsWith('1/3'), true);
        assert.partialDeepStrictEqual(row.segments[row.segments.length - 1], { text: '1/3', dim: true });
    }
});
test('a long title is not cut at 20 characters at width 80, and is cut with an ellipsis at the width', () => {
    const title = 'Fix the deferred plan tool, then land the whole branch today';
    const long: Plan = { title, nodes: [node('1', 'in_progress')], issued: [] };
    assert.equal(texts(buildTree(long, idle, { maxLines: 20, width: 80 }))[0], title);
    const narrow = texts(buildTree(long, idle, { maxLines: 20, width: 30 }))[0] ?? '';
    assert.equal(narrow.length, 30);
    assert.equal(narrow.endsWith('…'), true);
    const longLeaf: Plan = { title: 'P', nodes: [node('1', 'pending', { title: 'x'.repeat(100) })], issued: [] };
    const row = texts(buildTree(longLeaf, idle, { maxLines: 20, width: 40 })).find(l => l.includes('1 x')) ?? '';
    assert.equal(row.length, 40);
    assert.ok(row.includes('…'));
});
test('a tiny width never produces a negative pad or a throw, and counts keep one space of padding', () => {
    for (const width of [1, 5, 12]) {
        const lines = buildTree(twoLevel, idle, { maxLines: 20, width });
        const row = find(lines, '◉ 2 ');
        assert.equal(row.text.endsWith('1/3'), true);
        assert.match(row.text, / 1\/3$/);
    }
});
test('the progress bar uses a filled accent run and a dim track', () => {
    const lines = buildTree(twoLevel, idle, { maxLines: 20, width: 56 });
    const bar = lines[1];
    assert.partialDeepStrictEqual(bar?.segments[0], { text: '━'.repeat(20), color: DEFAULT_ACCENT });
    assert.partialDeepStrictEqual(bar?.segments[1], { text: '─'.repeat(20), dim: true });
    assert.partialDeepStrictEqual(bar?.segments[3], { text: '3/6 · 50%', dim: true });
    assert.partialDeepStrictEqual(lines[0]?.segments[0], { bold: true });
    const widths = [10, 20, 80].map(w => (buildTree(twoLevel, idle, { maxLines: 20, width: w })[1]?.text ?? '').split('  ')[0]?.length);
    assert.deepEqual(widths, [6, 6, 40]);
});
test('a custom accent colours the current row and the bar', () => {
    const lines = buildTree(twoLevel, { ...idle, phase: 'working' }, { maxLines: 20, accent: 'magenta' });
    assert.partialDeepStrictEqual(lines[1]?.segments[0], { color: 'magenta' });
    assert.partialDeepStrictEqual(segOf(find(lines, '2.2 T2.2'), 'T2.2'), { color: 'magenta', bold: true });
    assert.partialDeepStrictEqual(segOf(find(lines, '2.2 T2.2'), '◉'), { color: 'magenta' });
    assert.partialDeepStrictEqual(lines[2]?.segments[0], { color: 'magenta' });
    const defaultLeak = lines.some(l => l.segments.some(s => s.color === DEFAULT_ACCENT));
    assert.equal(defaultLeak, false);
});
test('the activity line is coloured by phase and omitted when idle', () => {
    const at = (phase: ActivityState['phase'], accent?: string): TreeLine[] => buildTree(twoLevel, { ...idle, phase, tool: 'Bash' }, { maxLines: 20, accent });
    const style = (phase: ActivityState['phase']): Seg | undefined => at(phase)[2]?.segments[0];
    assert.partialDeepStrictEqual(style('permission'), { color: 'yellow' });
    assert.partialDeepStrictEqual(style('question'), { color: 'yellow' });
    assert.partialDeepStrictEqual(style('error'), { color: 'red' });
    assert.partialDeepStrictEqual(style('interrupted'), { dim: true });
    assert.equal(style('interrupted')?.color, undefined);
    for (const phase of ['working', 'tool', 'compacting'] as const)
        assert.partialDeepStrictEqual(style(phase), { color: DEFAULT_ACCENT });
    assert.partialDeepStrictEqual(at('working', '#c084fc')[2]?.segments[0], { color: '#c084fc' });
    const quiet = texts(at('idle'));
    assert.equal(quiet[0], 'Add CSV');
    assert.ok(quiet[1]?.includes('3/6'));
    assert.equal(quiet[2], '');
    assert.equal(quiet.some(l => l.includes('Idle')), false);
});
test('a completed branch collapses to one dim line with a dim count', () => {
    const lines = buildTree(twoLevel, idle, { maxLines: 20 });
    const row = find(lines, '1 T1');
    assert.equal(row.text, padded('├─ ✓ 1 T1', '2/2'));
    for (const s of row.segments.filter(x => x.text.trim() !== ''))
        assert.equal(s.dim, true);
    assert.equal(lines.some(l => l.text.includes('1.1')), false);
});
test('a current node 3 levels deep stays visible at maxLines 8 with a labelled +N more', () => {
    const deep = planOf(node('1', 'completed'), node('2', 'pending'), node('3', 'in_progress'), node('3.1', 'completed'), node('3.2', 'in_progress'), node('3.2.1', 'completed'), node('3.2.2', 'in_progress'), node('3.2.3', 'pending'), node('4', 'pending'));
    const lines = buildTree(deep, idle, { maxLines: 8 });
    assert.equal(lines.length, 8);
    assert.deepEqual(texts(lines), [
        'Add CSV  ━━━━─────  3/7',
        '├─ ✓ 1 T1',
        '├─ ○ 2 T2',
        padded('├─ ◉ 3 T3', '2/4'),
        padded('│  └─ ◉ 3.2 T3.2', '1/3'),
        '│     ├─ ◉ 3.2.2 T3.2.2 ◂',
        '└─ ○ 4 T4',
        '+3 more · 2 done, 1 pending',
    ]);
});
test('the first blocked leaf is highlighted when only blocked work is left', () => {
    const blocked = planOf(node('1', 'completed'), node('2', 'blocked', { note: 'wait' }), node('3', 'blocked'));
    const lines = buildTree(blocked, idle, { maxLines: 20 });
    assert.partialDeepStrictEqual(segOf(find(lines, '2 T2'), 'T2'), { bold: true, color: DEFAULT_ACCENT });
    assert.ok(find(lines, '2 T2').text.includes('◂'));
    assert.ok(!find(lines, '3 T3').text.includes('◂'));
    assert.equal(statusLine(blocked, idle), 'Plan 1/3 · T2');
});
test('the empty state reads "No plan yet."', () => {
    assert.deepEqual(texts(buildTree(planOf(), idle, { maxLines: 10 })), ['No plan yet.']);
});
test('statusLine covers every activity phase', () => {
    const plan = planOf(node('1', 'completed'), node('2', 'in_progress', { activeForm: 'Escaping quotes' }), node('3', 'pending'));
    const at = (a: Partial<ActivityState>): string | undefined => statusLine(plan, { ...idle, ...a });
    assert.equal(at({}), 'Plan 1/3 · Escaping quotes');
    assert.equal(at({ phase: 'working' }), 'Plan 1/3 · Escaping quotes · Working');
    assert.equal(at({ phase: 'tool', tool: 'Bash' }), 'Plan 1/3 · Escaping quotes · Running Bash');
    assert.equal(at({ phase: 'permission', tool: 'Bash' }), 'Plan 1/3 · Escaping quotes · Waiting for permission: Bash');
    assert.equal(at({ phase: 'question' }), 'Plan 1/3 · Escaping quotes · Waiting for your answer');
    assert.equal(at({ phase: 'compacting' }), 'Plan 1/3 · Escaping quotes · Compacting');
    assert.equal(at({ phase: 'interrupted' }), 'Plan 1/3 · Escaping quotes · Interrupted');
    assert.equal(at({ phase: 'error', detail: 'rate limit' }), 'Plan 1/3 · Escaping quotes · Error: rate limit');
    const longPlan = planOf(node('1', 'in_progress', { activeForm: 'x'.repeat(50) }));
    assert.equal(statusLine(longPlan, idle), `Plan 0/1 · ${'x'.repeat(29)}…`);
    assert.equal(statusLine(planOf(), idle), undefined);
    assert.equal(statusLine(planOf(), { ...idle, phase: 'working' }), 'Working');
});
test('no glyph is an emoji (Extended_Pictographic)', () => {
    for (const glyph of Object.values(GLYPHS))
        assert.equal(/\p{Extended_Pictographic}/u.test(glyph), false);
    assert.equal(Object.values(GLYPHS).join(''), '✓◉○■–├─└─│━─◂∥');
});
const parallelPlan = planOf(node('1', 'completed'), node('2', 'in_progress', { parallel: true }), node('2.1', 'in_progress'), node('2.2', 'in_progress'), node('2.3', 'pending'), node('3', 'pending'));
test('a parallel parent gets a dim tag right after its title, before the right-aligned count', () => {
    const row = find(buildTree(parallelPlan, idle, { maxLines: 20, width: 56 }), '2 T2');
    const at = (needle: string): number => row.segments.findIndex(s => s.text.includes(needle));
    assert.partialDeepStrictEqual(segOf(row, '∥ parallel'), { text: ' ∥ parallel', dim: true });
    assert.equal(at('∥ parallel'), at('T2') + 1);
    assert.equal(row.text.length, 56);
    assert.partialDeepStrictEqual(row.segments[row.segments.length - 1], { text: '0/3', dim: true });
    const plain = find(buildTree(twoLevel, idle, { maxLines: 20 }), '2 T2');
    assert.ok(!plain.text.includes('∥'));
});
test('two running leaves in a parallel group both get the accent and bold, and only the first gets the marker', () => {
    const lines = buildTree(parallelPlan, idle, { maxLines: 20, accent: 'magenta' });
    const first = find(lines, '2.1 T2.1');
    const second = find(lines, '2.2 T2.2');
    for (const row of [first, second]) {
        assert.partialDeepStrictEqual(segOf(row, '◉'), { color: 'magenta' });
        assert.partialDeepStrictEqual(segOf(row, row === first ? 'T2.1' : 'T2.2'), { color: 'magenta', bold: true });
    }
    assert.ok(first.text.includes('◂'));
    assert.ok(!second.text.includes('◂'));
    assert.equal(lines.filter(l => l.text.includes('◂')).length, 1);
});
test('truncation keeps the paths to every running leaf', () => {
    const big = planOf(node('1', 'pending'), node('2', 'pending'), node('3', 'in_progress', { parallel: true }), node('3.1', 'in_progress'), node('3.2', 'pending'), node('3.3', 'in_progress'), node('4', 'pending'), node('5', 'pending'));
    const lines = buildTree(big, idle, { maxLines: 7 });
    const shown = texts(lines);
    assert.equal(shown.some(t => t.includes('3.1 T3.1')), true);
    assert.equal(shown.some(t => t.includes('3.3 T3.3')), true);
    assert.equal(shown.some(t => t.includes('3 T3')), true);
    assert.match(shown[shown.length - 1]!, /^\+\d+ more · \d+ pending$/);
});
test('statusLine names the first running leaf and counts the others', () => {
    assert.equal(statusLine(parallelPlan, idle), 'Plan 1/5 · T2.1 +1 more running');
    const long = planOf(node('1', 'in_progress', { parallel: true, title: 'g' }), node('1.1', 'in_progress', { activeForm: 'x'.repeat(50) }), node('1.2', 'in_progress'), node('1.3', 'in_progress'));
    assert.equal(statusLine(long, { ...idle, phase: 'working' }), `Plan 0/3 · ${'x'.repeat(29)}… +2 more running · Working`);
});
test('the parallel glyph passes the no-emoji test and is U+2225', () => {
    assert.equal(GLYPHS.parallel, '∥');
    assert.equal(/\p{Extended_Pictographic}/u.test(GLYPHS.parallel), false);
});
const manyAtWidth = planOf(node('1', 'in_progress', { parallel: true }), node('1.1', 'in_progress', { title: 'A very long step title that cannot fit' }), node('1.2', 'blocked', { note: 'waiting on a long answer from the owner' }));
const busy: ActivityState = { phase: 'tool', tool: 'WebSearch', subagents: ['a', 'b'], running: [], since: 0 };
test('buildTree draws exact lines for the 2-level fixture at width 40', () => {
    const lines = buildTree(twoLevel, toolActivity, { maxLines: 20, width: 40 });
    assert.deepEqual(texts(lines), [
        'Add CSV',
        `${'━'.repeat(13)}${'─'.repeat(13)}  3/6`,
        '◉ Running Bash · 1 subagent',
        '',
        '├─ ✓ 1 T1 2/2',
        '├─ ◉ 2 T2 1/3',
        '│  ├─ ✓ 2.1 T2.1',
        '│  ├─ ◉ 2.2 T2.2 ◂',
        '│  └─ ■ 2.3 T2.3 (blocked: flag name…',
        '└─ ○ 3 T3',
    ]);
});
test('a narrow parent row shows a dim count after the title and a bare parallel tag', () => {
    const lines = buildTree(manyAtWidth, idle, { maxLines: 20, width: 40 });
    const row = find(lines, '1 T1');
    assert.equal(row.text, '└─ ◉ 1 T1 0/2 ∥');
    assert.partialDeepStrictEqual(segOf(row, '0/2'), { dim: true });
    assert.partialDeepStrictEqual(segOf(row, GLYPHS.parallel), { dim: true });
});
test('the narrow activity line drops the subagent count when it would overflow', () => {
    const lines = buildTree(twoLevel, busy, { maxLines: 20, width: 30 });
    assert.equal(lines[2]?.text, '◉ Running WebSearch');
});
test('no line is longer than the width at widths 30 and 40', () => {
    for (const width of [30, 40]) {
        for (const plan of [twoLevel, manyAtWidth]) {
            for (const activity of [idle, toolActivity, busy]) {
                for (const line of buildTree(plan, activity, { maxLines: 20, width })) {
                    assert.ok(line.text.length <= width);
                }
            }
        }
    }
});
test('at width 56 the layout is unchanged: percentage, right-aligned counts, full notes', () => {
    const lines = buildTree(twoLevel, idle, { maxLines: 20, width: 56 });
    assert.equal(lines[1]?.text, `${'━'.repeat(20)}${'─'.repeat(20)}  3/6 · 50%`);
    assert.equal(find(lines, '1 T1').text, padded('├─ ✓ 1 T1', '2/2', 56));
    assert.equal(find(lines, '2.3').text, '│  └─ ■ 2.3 T2.3 (blocked: flag name?)');
});
test('preferredRows counts every line the tree would draw with no limit', () => {
    assert.equal(preferredRows(twoLevel, idle), buildTree(twoLevel, idle, { maxLines: 1000 }).length);
    assert.equal(preferredRows(twoLevel, idle), 9);
    assert.equal(preferredRows(twoLevel, toolActivity), 10);
    assert.equal(preferredRows(planOf(), idle), 1);
});
// The owner's shape: 6 groups of 3, everything done except 3.2 which is blocked with a long note.
const owner = (): Plan => {
    const nodes: PlanNode[] = [];
    for (let g = 1; g <= 6; g++) {
        nodes.push(node(`${g}`, g === 3 ? 'blocked' : 'completed', { title: `Group ${g}` }));
        for (let k = 1; k <= 3; k++) {
            const blocked = g === 3 && k === 2;
            nodes.push(node(`${g}.${k}`, blocked ? 'blocked' : 'completed', {
                title: `Step ${g}.${k}`,
                ...(blocked ? { note: 'waiting on the owner to confirm the long running migration window '.repeat(3) } : {}),
            }));
        }
    }
    return { title: 'Six-group demo plan', nodes, issued: [] };
};
test('truncation keeps tree order', () => {
    const rows = texts(buildTree(owner(), idle, { maxLines: 8, width: 80 }));
    const ids = rows.map(t => /(\d(?:\.\d)?) (?:Group|Step)/.exec(t)?.[1]).filter((x): x is string => x !== undefined);
    assert.deepEqual(ids, [...ids].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })));
});
test('completed top-level runs fold into one line when the rows do not fit', () => {
    const rows = texts(buildTree(owner(), idle, { maxLines: 6, width: 80 }));
    assert.ok(rows.includes('✓ 1–2, 4–6 done'));
    const lone = planOf(node('1', 'completed'), node('2', 'in_progress'), node('3', 'completed'), node('4', 'pending'), node('5', 'pending'));
    assert.ok(texts(buildTree(lone, idle, { maxLines: 5, width: 80 })).includes('✓ 1, 3 done'));
});
test('the overflow label counts hidden rows by status and omits zeros', () => {
    const plan = planOf(node('1', 'in_progress'), node('1.1', 'in_progress'), node('1.2', 'pending'), node('1.3', 'pending'), node('1.4', 'completed'), node('1.5', 'blocked'), node('1.6', 'pending'));
    const rows = texts(buildTree(plan, idle, { maxLines: 6 }));
    assert.equal(rows[rows.length - 1], '+3 more · 1 done, 1 blocked, 1 pending');
    const none = planOf(node('1', 'in_progress'), node('1.1', 'in_progress'), node('1.2', 'pending'), node('1.3', 'pending'), node('1.4', 'pending'));
    assert.equal(texts(buildTree(none, idle, { maxLines: 5 })).pop(), '+2 more · 2 pending');
});
test('at maxLines 6 the owner shape shows the folded line, the blocked path and a labelled more line', () => {
    const rows = texts(buildTree(owner(), idle, { maxLines: 6, width: 100 }));
    assert.equal(rows.length, 6);
    assert.ok(rows[0]?.includes('Six-group demo plan'));
    assert.equal(rows[1], '✓ 1–2, 4–6 done');
    assert.ok(rows[2]?.includes('■ 3 Group 3'));
    assert.equal(rows.some(t => t.includes('3.2 Step 3.2') && t.includes('◂')), true);
    assert.match(rows[rows.length - 1]!, /^\+\d+ more · \d+ done/);
});
test('under 10 lines the header is one line with no blank, and the activity line shows only when busy', () => {
    const calm = texts(buildTree(twoLevel, idle, { maxLines: 9, width: 56 }));
    assert.match(calm[0]!, /^Add CSV {2}━+─+ {2}3\/6$/);
    assert.ok(calm[1]?.includes('1 T1'));
    assert.equal(calm.includes(''), false);
    const busyRows = texts(buildTree(twoLevel, toolActivity, { maxLines: 9, width: 56 }));
    assert.equal(busyRows[1], '◉ Running Bash · 1 subagent');
    const roomy = texts(buildTree(twoLevel, idle, { maxLines: 10, width: 56 }));
    assert.equal(roomy[2], '');
});
test('no line is longer than the width with a long blocked note at widths 40, 56 and 120', () => {
    for (const width of [40, 56, 120]) {
        for (const maxLines of [6, 20]) {
            for (const line of buildTree(owner(), idle, { maxLines, width })) {
                assert.ok(line.text.length <= width);
            }
        }
    }
    const row = texts(buildTree(owner(), idle, { maxLines: 20, width: 56 })).find(t => t.includes('3.2 ')) ?? '';
    assert.ok(row.includes('3.2 Step 3.2'));
    assert.ok(row.includes('(blocked: '));
});
test('a blocked parent shows no (blocked) text, and a blocked leaf without a note shows none either', () => {
    const rows = texts(buildTree(owner(), idle, { maxLines: 20, width: 100 }));
    const parent = rows.find(t => t.includes('3 Group 3')) ?? '';
    assert.ok(!parent.includes('blocked'));
    const bare = planOf(node('1', 'blocked'), node('2', 'pending'));
    assert.equal(texts(buildTree(bare, idle, { maxLines: 20 })).find(t => t.includes('1 T1')), '├─ ■ 1 T1');
});
test('paneRows asks for what the tree wants, clamped to 6..20', () => {
    assert.equal(paneRows(planOf(), idle), 6);
    assert.equal(paneRows(owner(), idle), 12);
    const huge = planOf(...Array.from({ length: 40 }, (_, i) => node(`${i + 1}`, 'pending')));
    assert.equal(paneRows(huge, idle), 20);
});
