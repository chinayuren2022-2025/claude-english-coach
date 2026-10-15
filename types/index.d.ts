export type Phrase = { zh: string; en: string }

export type Feedback =
  | { kind: 'pending'; original: string }
  | { kind: 'translated'; original: string; english: string; phrases: Phrase[] }
  | {
      kind: 'checked'
      original: string
      isNatural: boolean
      better: string
      // Short tips in Chinese, one per main mistake.
      tips: string[]
      upgrade: string
      // True while the message waits in the box for the person to send it.
      isHeld: boolean
      // Which version a held message has in the box: the fix (the default) or the person's own.
      inBox?: 'better' | 'original'
    }

// What the level slider under the prompt draws.
export type LevelView = {
  isOn: boolean
  level: string
  isMeasuring: boolean
  samples: number
  needed: number
  goal: string
  // The goal on the CEFR scale (IELTS 7.5 is C1), null when it cannot be read.
  goalLevel: string | null
}

// A Chinese gloss for a word or phrase in one of Claude's replies.
export type Gloss = { term: string; zh: string }

// The glosses of each reply block, by its requestId, for the text they were made from.
export type ReplyGlosses = Record<string, { text: string; glosses: Gloss[] }>

declare module 'claude-code' {
  interface PluginState {
    'english-coach': { feedback: Feedback | null; level: LevelView | null; glosses: ReplyGlosses }
  }
}
