import { KIND_NAMES, parseKind, WINDOW_KINDS } from "./window.js";
// Client-independent window operations and their input schema.
export const WINDOW_TOOL_SHORT_NAME = 'window';
export const WINDOW_TOOL_DESCRIPTION = [
    "Keep this window's list of open items, shown under the plan in the user's pane.",
    `Kinds: ${WINDOW_KINDS.map(kind => `${kind} ${KIND_NAMES[kind]}`).join(', ')}.`,
    'op "add" with "kind" and a one-line "title" adds an item and answers its id; op "done" with "ids" closes items; op "skip" with "ids" moves items to the bottom with the same ids; op "prune" removes the done items (ids are still never reused). Every call answers the list as it is now.',
    'Any question you end a reply on that waits for the user goes in as a Q item.',
].join(' ');
export const WINDOW_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        op: { type: 'string', enum: ['add', 'done', 'skip', 'prune'] },
        kind: { type: 'string', enum: [...WINDOW_KINDS] },
        title: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['op'],
};
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export const parseWindowInput = (raw) => {
    if (!isRecord(raw))
        return { error: 'the window tool takes an object with an "op" field' };
    switch (raw.op) {
        case 'add': {
            const kind = typeof raw.kind === 'string' ? parseKind(raw.kind) : null;
            if (kind === null)
                return { error: `op add needs "kind", one of ${WINDOW_KINDS.join(', ')}` };
            if (typeof raw.title !== 'string')
                return { error: 'op add needs a "title" string' };
            return { op: 'add', kind, title: raw.title };
        }
        case 'done':
        case 'skip': {
            const ids = raw.ids;
            if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
                return { error: `op ${raw.op} needs "ids", a non-empty array of strings` };
            }
            return { op: raw.op, ids };
        }
        case 'prune':
            return { op: 'prune' };
        default:
            return { error: 'unknown or missing "op"; use add, done, skip or prune' };
    }
};
