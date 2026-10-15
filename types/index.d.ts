export type Phrase = { zh: string; en: string }

export type Feedback =
  | { kind: 'pending'; original: string }
  | { kind: 'translated'; original: string; english: string; phrases: Phrase[] }
  | {
      kind: 'checked'
      original: string
      isNatural: boolean
      better: string
      tip: string
      upgrade: string
      // True while the message waits in the box for the person to fix it.
      isHeld: boolean
    }

declare module 'claude-code' {
  interface PluginState {
    'english-coach': { feedback: Feedback | null }
  }
}
