import { WINDOW_TOOL_FULL_NAME } from './window-tool'

// The Stop reminder, after sirkitree/pinboard: a question left only in the reply scrolls away,
// so an answer that ends on one while the window list holds no open Q item is sent back once.

// True when one of the last three prose lines of the reply ends on a question mark (code
// blocks are ignored, and closing markup after the mark still counts). As pinboard has it.
export function asksUser(reply: string): boolean {
  const prose = reply.replace(/```[\s\S]*?```/g, '')
  const lines = prose
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-3)

  return lines.some(line => /\?[*_`)"'\]]*$/.test(line))
}

export const STOP_NUDGE =
  'Your reply ends on a question for the user, but the window list has no open Q item. ' +
  `Call ${WINDOW_TOOL_FULL_NAME} with {"op":"add","kind":"Q","title":"<the question>"}, then end your turn. ` +
  'If it was rhetorical, end your turn as is.'
