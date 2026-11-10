import type { ActivityState, Plan, PlanToolState, TaskState, WindowList } from '../shared/types'
import type { PaneFit } from './fit'
import type { MirrorState } from './mirror'

// The plugin's Claude state, written against the shared types. The build inlines it into
// claude/state.d.ts, the self-contained contract the Claude SDK requires.
export type WindowTodoState = {
  plan: Plan
  task: TaskState
  activity: ActivityState
  enforceSession: boolean
  dropShown: boolean
  accentOverride: string | null
  firstPromptOpen: 'idle' | 'armed' | 'done'
  planTool: PlanToolState
  paneFit: PaneFit | null
  window: WindowList
  windowSession: string
  mirror: MirrorState
}
