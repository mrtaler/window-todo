import { activityLabel } from "./activity.js";
import { activeLeaves, currentNode, progress } from "./plan.js";
export const GLYPHS = {
    completed: '✓',
    in_progress: '◉',
    pending: '○',
    blocked: '■',
    skipped: '–',
    branch: '├─',
    last: '└─',
    pipe: '│',
    filled: '━',
    track: '─',
    marker: '◂',
    parallel: '∥',
};
export const DEFAULT_WIDTH = 56;
export const DEFAULT_ACCENT = 'claude';
const STATUS_TITLE_MAX = 30;
// Below this width the pane drops the percentage, right-aligned counts and long notes.
export const NARROW_WIDTH = 50;
const NARROW_NOTE_MAX = 20;
const NOTE_FLOOR = 12;
export const COMPACT_BELOW = 10;
const seg = (text, over = {}) => ({ text, bold: false, dim: false, ...over });
const dimSeg = (text) => seg(text, { dim: true });
const lineOf = (segments) => ({ text: segments.map(s => s.text).join(''), segments });
const blank = () => lineOf([seg('')]);
const percent = (done, total) => (total === 0 ? 0 : Math.round((done / total) * 100));
const shorten = (text, max) => {
    if (text.length <= max)
        return text;
    return max <= 1 ? '…' : `${text.slice(0, max - 1)}…`;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const bar = (done, total, accent, width) => {
    const narrow = width < NARROW_WIDTH;
    const cells = narrow ? clamp(width - 14, 6, 40) : clamp(width - 16, 10, 40);
    const filled = total === 0 ? 0 : Math.round((done / total) * cells);
    return [
        seg(GLYPHS.filled.repeat(filled), { color: accent }),
        dimSeg(GLYPHS.track.repeat(cells - filled)),
        seg('  '),
        dimSeg(narrow ? `${done}/${total}` : `${done}/${total} · ${percent(done, total)}%`),
    ];
};
const childrenOf = (nodes, id) => nodes.filter(n => n.parentId === id);
const leavesUnder = (nodes, id) => {
    const kids = childrenOf(nodes, id);
    return kids.length === 0 ? [] : kids.flatMap(k => (childrenOf(nodes, k.id).length === 0 ? [k] : leavesUnder(nodes, k.id)));
};
const countUnder = (nodes, id) => {
    const under = leavesUnder(nodes, id);
    const done = under.filter(n => n.status === 'completed' || n.status === 'skipped').length;
    return `${done}/${under.length}`;
};
const highlighted = (plan) => {
    const current = currentNode(plan);
    if (current !== null)
        return current;
    return plan.nodes.find(n => n.status === 'blocked' && childrenOf(plan.nodes, n.id).length === 0) ?? null;
};
const glyphStyle = (status, accent) => {
    switch (status) {
        case 'completed':
            return { color: 'green' };
        case 'in_progress':
            return { color: accent };
        case 'blocked':
            return { color: 'yellow' };
        case 'skipped':
            return { dim: true };
        case 'pending':
            return {};
    }
};
// The note text without a leading space: a leaf's own note, with its status when blocked or
// skipped. A parent (hasKids) and a blocked leaf with no note carry none: the glyph says it.
const noteOf = (node, hasKids) => {
    if (hasKids)
        return '';
    const tagged = node.status === 'blocked' || node.status === 'skipped';
    if (node.note !== undefined)
        return tagged ? `(${node.status}: ${node.note})` : `(${node.note})`;
    return node.status === 'skipped' ? '(skipped)' : '';
};
const PARALLEL_TAG = ` ${GLYPHS.parallel} parallel`;
const PARALLEL_TAG_NARROW = ` ${GLYPHS.parallel}`;
const rowFor = (ctx, node, lead, hasKids, collapse) => {
    const { plan, currentId, runningIds, accent, width } = ctx;
    const isCurrent = node.id === currentId;
    const isRunning = !hasKids && runningIds.includes(node.id);
    const narrow = width < NARROW_WIDTH;
    const tag = node.parallel === true && hasKids ? (narrow ? PARALLEL_TAG_NARROW : PARALLEL_TAG) : '';
    const count = hasKids ? countUnder(plan.nodes, node.id) : null;
    const marker = isCurrent ? ` ${GLYPHS.marker}` : '';
    const countWidth = count === null ? 0 : count.length + 1;
    const rest = lead.length + 2 + node.id.length + 1 + tag.length + marker.length + countWidth;
    const avail = width - rest;
    const full = collapse ? '' : noteOf(node, hasKids);
    let note = '';
    let title = node.title;
    if (full !== '') {
        const cap = narrow ? NARROW_NOTE_MAX : Number.POSITIVE_INFINITY;
        const fitsAfterTitle = avail - node.title.length - 1;
        const floor = Math.min(NOTE_FLOOR, cap, full.length);
        const room = Math.min(clamp(fitsAfterTitle, floor, cap), avail - 2);
        if (room >= 2)
            note = shorten(full, room);
    }
    title = shorten(title, Math.max(1, avail - (note === '' ? 0 : note.length + 1)));
    let titleSeg;
    let glyphSeg;
    if (collapse) {
        titleSeg = dimSeg(title);
        glyphSeg = dimSeg(GLYPHS[node.status]);
    }
    else {
        glyphSeg = seg(GLYPHS[node.status], glyphStyle(node.status, accent));
        if (isCurrent || isRunning)
            titleSeg = seg(title, { color: accent, bold: true });
        else if (hasKids)
            titleSeg = seg(title, { bold: true });
        else if (node.status === 'completed')
            titleSeg = dimSeg(title);
        else if (node.status === 'in_progress')
            titleSeg = seg(title, { bold: true });
        else if (node.status === 'skipped')
            titleSeg = seg(title, { dim: true, strikethrough: true });
        else
            titleSeg = seg(title);
    }
    const segs = [dimSeg(lead), glyphSeg, seg(' '), dimSeg(node.id), seg(' '), titleSeg];
    if (narrow && count !== null)
        segs.push(dimSeg(` ${count}`));
    if (tag !== '')
        segs.push(dimSeg(tag));
    if (note !== '')
        segs.push(dimSeg(` ${note}`));
    if (marker !== '')
        segs.push(dimSeg(marker));
    if (!narrow && count !== null) {
        const used = segs.reduce((n, s) => n + s.text.length, 0);
        segs.push(seg(' '.repeat(Math.max(1, width - used - count.length))), dimSeg(count));
    }
    return lineOf(segs);
};
const rowsFor = (ctx, parentId, prefix) => {
    const { plan, runningIds } = ctx;
    const kids = plan.nodes.filter(n => n.parentId === parentId);
    const out = [];
    kids.forEach((node, i) => {
        const isLast = i === kids.length - 1;
        const hasKids = childrenOf(plan.nodes, node.id).length > 0;
        const isRunning = !hasKids && runningIds.includes(node.id);
        const isAncestor = runningIds.some(id => id.startsWith(`${node.id}.`));
        const collapse = hasKids && node.status === 'completed' && !isAncestor;
        const lead = `${prefix}${isLast ? GLYPHS.last : GLYPHS.branch} `;
        out.push({ line: rowFor(ctx, node, lead, hasKids, collapse), keep: isRunning || isAncestor, node, top: parentId === null });
        if (hasKids && !collapse) {
            out.push(...rowsFor(ctx, node.id, `${prefix}${isLast ? '   ' : `${GLYPHS.pipe}  `}`));
        }
    });
    return out;
};
const activityLine = (activity, accent, width) => {
    let label = activityLabel(activity);
    if (label === undefined)
        return null;
    if (width < NARROW_WIDTH && label.length + 2 > width) {
        // Drop the subagent count first, then cut what is left to the width.
        label = activityLabel({ ...activity, subagents: [] }) ?? label;
    }
    const text = shorten(`${GLYPHS.in_progress} ${label}`, width);
    switch (activity.phase) {
        case 'permission':
        case 'question':
            return lineOf([seg(text, { color: 'yellow' })]);
        case 'error':
            return lineOf([seg(text, { color: 'red' })]);
        case 'interrupted':
            return lineOf([dimSeg(text)]);
        case 'idle':
            return lineOf([dimSeg(shorten(`${GLYPHS.pending} ${label}`, width))]);
        case 'working':
        case 'tool':
        case 'compacting':
            return lineOf([seg(text, { color: accent })]);
    }
};
const doneTop = (r) => r.node.status === 'completed' && !r.keep;
// "1-2, 4-7" for the top-level ids, in tree order, runs of adjacent rows joined with an en dash.
const rangesOf = (ids) => ids.map(run => (run.length === 1 ? run[0] : `${run[0]}–${run[run.length - 1]}`)).join(', ');
const overflowLabel = (hidden) => {
    const count = (pick) => hidden.filter(r => pick(r.node.status)).length;
    const parts = [
        [count(s => s === 'completed' || s === 'skipped'), 'done'],
        [count(s => s === 'in_progress'), 'running'],
        [count(s => s === 'blocked'), 'blocked'],
        [count(s => s === 'pending'), 'pending'],
    ];
    const text = parts.filter(([n]) => n > 0).map(([n, name]) => `${n} ${name}`).join(', ');
    return `+${hidden.length} more${text === '' ? '' : ` · ${text}`}`;
};
// Picks which rows fit in `budget` lines, always in tree order. Kept first: the paths to the
// running leaves; then every top-level row; then the current leaf's siblings; then the rest.
// When the first two tiers alone do not fit, completed top-level rows fold into one line.
const fitRows = (rows, budget, current, width) => {
    const keepCount = rows.filter(r => r.keep).length;
    const topCount = rows.filter(r => !r.keep && r.top).length;
    const fold = keepCount + topCount > budget;
    const folded = fold ? rows.filter(r => r.top && doneTop(r)) : [];
    const foldLine = (() => {
        if (folded.length === 0)
            return null;
        const runs = [];
        let prev = -2;
        rows.forEach((r, i) => {
            if (!folded.includes(r))
                return;
            if (i === prev + 1 && runs.length > 0)
                runs[runs.length - 1]?.push(r.node.id);
            else
                runs.push([r.node.id]);
            prev = i;
        });
        return lineOf([dimSeg(shorten(`${GLYPHS.completed} ${rangesOf(runs)} done`, width))]);
    })();
    const tierOf = (r) => {
        if (r.keep)
            return 0;
        if (r.top)
            return 1;
        if (current !== null && r.node.parentId === current.parentId)
            return 2;
        return 3;
    };
    const picked = new Set(rows.filter(r => r.keep));
    let spare = budget - keepCount - (foldLine === null ? 0 : 1);
    for (const tier of [1, 2, 3]) {
        for (const row of rows) {
            if (spare <= 0)
                break;
            if (tierOf(row) === tier && !folded.includes(row)) {
                picked.add(row);
                spare -= 1;
            }
        }
    }
    const out = [];
    let foldPlaced = false;
    const hidden = [];
    for (const row of rows) {
        if (folded.includes(row)) {
            if (!foldPlaced && foldLine !== null)
                out.push(foldLine);
            foldPlaced = true;
        }
        else if (picked.has(row))
            out.push(row.line);
        else
            hidden.push(row);
    }
    if (hidden.length > 0)
        out.push(lineOf([dimSeg(shorten(overflowLabel(hidden), width))]));
    return out;
};
const compactHead = (plan, done, total, accent, width) => {
    const cells = clamp(Math.round(width / 6), 4, 10);
    const filled = total === 0 ? 0 : Math.round((done / total) * cells);
    const count = `${done}/${total}`;
    const title = shorten(plan.title, Math.max(1, width - cells - count.length - 4));
    return lineOf([
        seg(title, { bold: true }),
        seg('  '),
        seg(GLYPHS.filled.repeat(filled), { color: accent }),
        dimSeg(GLYPHS.track.repeat(cells - filled)),
        seg('  '),
        dimSeg(count),
    ]);
};
export const buildTree = (plan, activity, opts) => {
    const width = opts.width ?? DEFAULT_WIDTH;
    const accent = opts.accent ?? DEFAULT_ACCENT;
    const act = activityLine(activity, accent, width);
    if (plan.nodes.length === 0) {
        const empty = lineOf([dimSeg('No plan yet.')]);
        return act === null ? [empty] : [empty, act];
    }
    const { done, total } = progress(plan);
    const tight = opts.maxLines < COMPACT_BELOW;
    const head = tight
        ? [compactHead(plan, done, total, accent, width)]
        : [lineOf([seg(shorten(plan.title, width), { bold: true })]), lineOf(bar(done, total, accent, width))];
    if (act !== null)
        head.push(act);
    if (!tight)
        head.push(blank());
    const current = highlighted(plan);
    const runningIds = [...new Set([...activeLeaves(plan).map(n => n.id), ...(current === null ? [] : [current.id])])];
    const rows = rowsFor({ plan, currentId: current?.id ?? null, runningIds, accent, width }, null, '');
    const room = opts.maxLines - head.length;
    if (rows.length <= room)
        return [...head, ...rows.map(r => r.line)];
    return [...head, ...fitRows(rows, Math.max(room - 1, 1), current, width)];
};
export const preferredRows = (plan, activity) => buildTree(plan, activity, { maxLines: Number.POSITIVE_INFINITY }).length;
export const PANE_MIN_ROWS = 6;
export const PANE_MAX_ROWS = 20;
// The body height to ask the host for: what the tree wants, clamped.
export const paneRows = (plan, activity) => Math.min(PANE_MAX_ROWS, Math.max(PANE_MIN_ROWS, preferredRows(plan, activity)));
export const statusLine = (plan, activity) => {
    const label = activityLabel(activity);
    if (plan.nodes.length === 0)
        return label;
    const { done, total } = progress(plan);
    const node = highlighted(plan);
    const parts = [`Plan ${done}/${total}`];
    if (node !== null) {
        const extra = activeLeaves(plan).length - 1;
        const first = shorten(node.activeForm ?? node.title, STATUS_TITLE_MAX);
        parts.push(extra > 0 ? `${first} +${extra} more running` : first);
    }
    if (label !== undefined)
        parts.push(label);
    return parts.join(' · ');
};
