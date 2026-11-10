import type { ActivityState, Plan, PlanToolState, TaskState, WindowList } from '../shared/types'
import type { PaneFit } from './fit'

// The build inlines these shared types for the Claude SDK, which requires literal atom schemas.
declare module 'claude-code' {
  interface PluginState {
    'window-todo': {
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
    }
  }
}
