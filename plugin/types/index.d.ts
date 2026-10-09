export type Worker = {
  id: string
  type: string
  description: string
  spawnAt: number
  doneAt?: number
  isOk?: boolean
  tool?: string
  // agent details (contract v2.2), all optional: files without them keep working
  prompt?: string // the task given to the agent, whitespace collapsed, ≤ 600 chars
  detail?: string // the current tool's input in one line, ≤ 160 chars
  history?: ToolCall[] // the last 20 tool calls, oldest first
  toolCount?: number // all tool calls so far
  result?: string // the agent's final answer, ≤ 600 chars, once done
}

export type ToolCall = { at: number; tool: string; detail: string }

// today: ids delivered on that local day; outlives FORGET so the viewer's TODAY count never misses one
export type OfficeStats = { delivered: number; isBossBusy: boolean; today?: { date: string; ids: string[] } }

// the last frame the viewer wrote: its number and the theme's colours (hex without #)
export type OfficeFrame = { gen: number; accent: string; frameColor: string; title: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-office': {
      workers: Worker[]
      stats: OfficeStats
      inboxSeen: number
      isOpen: boolean
      frame: OfficeFrame
    }
  }
}
