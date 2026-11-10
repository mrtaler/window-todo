// `unknown` is justified: the host hands the tool's input and response over untyped.
const isDict = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string';
// Task ids arrive as strings; a number is accepted and kept as text.
const idText = (value) => isText(value) && value !== '' ? value : typeof value === 'number' ? String(value) : undefined;
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'deleted'];
const TODO_STATUSES = ['pending', 'in_progress', 'completed'];
export const taskCreateFrom = (input, response) => {
    if (!isDict(input) || !isDict(response) || !isDict(response.task))
        return null;
    const id = idText(response.task.id);
    if (id === undefined || !isText(input.subject))
        return null;
    const out = { id, subject: input.subject };
    if (isText(input.activeForm))
        out.activeForm = input.activeForm;
    return out;
};
// A TaskUpdate the tool itself reported as failed: a known outcome, not an unrecognised shape.
export const taskUpdateFailed = (response) => isDict(response) && response.success === false;
// Only a call the tool reported as successful (`success: true`) counts.
export const taskUpdateFrom = (input, response) => {
    if (!isDict(input) || !isDict(response) || response.success !== true)
        return null;
    const taskId = idText(input.taskId);
    if (taskId === undefined)
        return null;
    const out = { taskId };
    if (isText(input.subject))
        out.subject = input.subject;
    if (isText(input.activeForm))
        out.activeForm = input.activeForm;
    if (input.status !== undefined) {
        if (!isText(input.status) || !TASK_STATUSES.includes(input.status))
            return null;
        out.status = input.status;
    }
    return out;
};
const todoList = (value) => {
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const item of value) {
        if (!isDict(item) || !isText(item.content) || !isText(item.status) || !TODO_STATUSES.includes(item.status))
            return null;
        const todo = { content: item.content, status: item.status };
        if (isText(item.activeForm))
            todo.activeForm = item.activeForm;
        out.push(todo);
    }
    return out;
};
// The list the tool stored (`newTodos`), else the list the call sent.
export const todosFrom = (input, response) => (isDict(response) ? todoList(response.newTodos) : null) ?? (isDict(input) ? todoList(input.todos) : null);
