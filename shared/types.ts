export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped'
export type PlanSource = 'plan' | 'todo' | 'task'
export type PlanNode = {
  id: string
  parentId: string | null
  title: string
  activeForm?: string
  status: PlanStatus
  note?: string
  parallel?: boolean
  source: PlanSource
  externalId?: string
  updatedAt: number
}
// `issued` remembers the last child number handed out per parent ('' is the top level), so a
// removed id is never reused.
export type Plan = {
  title: string
  nodes: PlanNode[]
  issued: Array<{ parent: string; last: number }>
}
export type TaskState = { open: boolean; planned: boolean; denies: number }
export type ActivityPhase =
  | 'idle'
  | 'working'
  | 'tool'
  | 'permission'
  | 'question'
  | 'compacting'
  | 'interrupted'
  | 'error'
export type ActivityState = {
  phase: ActivityPhase
  tool?: string
  detail?: string
  resume?: ActivityPhase
  subagents: string[]
  running: Array<{ id: string; tool: string }>
  since: number
}
export type PlanToolState = { name: string | null; offered: boolean }
// The window list: open items of this window, kept per session. Kinds are tasks, findings,
// questions and waits; `issued` holds the last number handed out per kind, so an id is never reused.
export type WindowKind = 'T' | 'F' | 'Q' | 'W'
export type WindowItem = { id: string; kind: WindowKind; title: string; isDone: boolean }
export type WindowList = { items: WindowItem[]; issued: { T: number; F: number; Q: number; W: number } }
