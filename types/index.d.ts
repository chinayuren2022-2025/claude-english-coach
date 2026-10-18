export type Phrase = { zh: string; en: string }

export type Feedback =
  | { kind: 'pending'; original: string }
  | {
      kind: 'translated'
      original: string
      english: string
      phrases: Phrase[]
      // While a draft waits in the box, which version it has: the English (the first) or the person's Chinese.
      inBox?: 'english' | 'chinese'
    }
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
      // Which version a held message has in the box: the fix (the first) or the person's own.
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

// A Chinese translation of one of Claude's replies, drawn under it for the person alone.
export type ReplyTranslation = {
  // The reply's paragraphs as Claude wrote them; a code block is one.
  paras: string[]
  // Each paragraph's Chinese, '' for a code block; null while Haiku translates it, false when that failed.
  zh: (string | null | false)[]
  isShown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'english-coach': {
      feedback: Feedback | null
      level: LevelView | null
      glosses: ReplyGlosses
      // The replies /zh translated, newest last.
      translations: ReplyTranslation[]
    }
  }
}
