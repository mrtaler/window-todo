import { hasUnfinished } from "../shared/plan.js";
// D6: main-loop tools that change state. Everything else is allowed, including third-party MCP tools.
export const BLOCKED_TOOLS = new Set([
    'Edit',
    'Write',
    'NotebookEdit',
    'Bash',
    'Agent',
    'Workflow',
    'CronCreate',
    'CronDelete',
    'EnterWorktree',
    'ExitWorktree',
    'RemoteTrigger',
]);
export const MAX_DENIES = 3;
export const PAUSE_TOAST = 'Plan enforcement paused for this turn';
// Follows the gate algorithm in docs/plan-tree/plan.md. `planToolName` is the full registered
// plan-tool name, used only in the deny text.
export const decideGate = (input) => {
    if (input.agentId !== undefined && input.agentId !== '')
        return { kind: 'allow' };
    if (!BLOCKED_TOOLS.has(input.tool) || input.isPlanTool)
        return { kind: 'allow' };
    if (!input.enforceConfig || !input.enforceSession || !input.toolRegistered || !input.toolOffered) {
        return { kind: 'allow' };
    }
    if (input.planned)
        return { kind: 'allow' };
    if (input.denies >= MAX_DENIES)
        return { kind: 'pause', toast: PAUSE_TOAST };
    return { kind: 'deny', message: denyText(input.tool, input.planToolName) };
};
// The decision plus the deny count that follows it, as one pure step. A deny and the first pause
// each add one to `denies`; the deny toast shows on the first deny and the pause toast once, because
// the pausing call moves `denies` past MAX_DENIES. Allows and later pauses return `cur` itself.
export function transition(cur, input) {
    const decision = decideGate({ ...input, planned: cur.planned, denies: cur.denies });
    if (decision.kind === 'deny') {
        return { next: { ...cur, denies: cur.denies + 1 }, decision, toast: cur.denies === 0 ? 'deny' : null };
    }
    if (decision.kind === 'pause' && cur.denies === MAX_DENIES) {
        return { next: { ...cur, denies: cur.denies + 1 }, decision, toast: 'pause' };
    }
    return { next: cur, decision, toast: null };
}
// D7 as revised: empty text and background-agent completions are continuations and change nothing.
export const onNewPrompt = (task, plan, text) => {
    if (text.trim() === '' || text.startsWith('<task-notification>'))
        return task;
    return { open: true, planned: hasUnfinished(plan), denies: 0 };
};
export const onPlanTouched = (task) => ({ ...task, planned: true });
export const INSTRUCTION_ID = 'window-todo:plan';
export const INSTRUCTION_TEXT = (toolName) => `Plan tree: before using any tool other than read-only ones, create a plan with the ${toolName} tool (op "set"). ` +
    'Before creating the plan, find steps that do not conflict (different files, independent research, separate subagents) and put them under one parent with "parallel": true, then run them concurrently (for example several Agent calls in one message). Outside a parallel group keep exactly one leaf in_progress. Mark each leaf completed immediately when it is done. ' +
    'Use blocked or skipped with a note when a leaf cannot or need not be done. ' +
    'When a requirement is unclear, ask with AskUserQuestion and mark the affected node blocked with the question as the note. ' +
    'Pure Q&A needs no plan. ' +
    `If the tool is not loaded, load it first with ToolSearch (query "select:${toolName}").`;
// Sent with each new prompt (D12). `format` renders the tree; without it the ids and statuses are listed.
// Returns undefined for an empty plan.
export const planContext = (plan, toolName, format) => {
    if (plan.nodes.length === 0)
        return undefined;
    const body = format !== undefined ? format(plan) : plan.nodes.map(n => `${n.id} ${n.status}`).join(', ');
    return `Current plan (update it with ${toolName}):\n${body}`;
};
export const denyText = (tool, toolName) => `Blocked ${tool}: there is no plan for this task yet. ` +
    `Call ${toolName} with {"op":"set","title":"<task>","nodes":[{"title":"<step>"}]} first, then retry ${tool}. ` +
    `If the tool is not loaded, load it first with ToolSearch (query "select:${toolName}").`;
