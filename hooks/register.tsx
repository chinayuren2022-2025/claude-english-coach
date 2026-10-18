import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderChildren, SessionMessage } from 'claude-code'

import type { Feedback, Gloss, LevelView, Phrase, ReplyGlosses, ReplyPoints, ReplyTranslation } from '../types'

const feedback = atom({ plugin: 'english-coach', key: 'feedback' } as const, null)
const levelView = atom({ plugin: 'english-coach', key: 'level' } as const, null)
const replyGlosses = atom({ plugin: 'english-coach', key: 'glosses' } as const, {} as ReplyGlosses)
const translations = atom({ plugin: 'english-coach', key: 'translations' } as const, [] as ReplyTranslation[])
const keyPoints = atom({ plugin: 'english-coach', key: 'points' } as const, [] as ReplyPoints[])

// Glosses per reply: at most this many replies kept, this many new blocks glossed per turn.
const GLOSSED_KEPT = 100
const BLOCKS_PER_TURN = 6
const GLOSSES_PER_BLOCK = 6

const LEVELS = ['A2', 'B1', 'B2', 'C1'] as const
type Level = (typeof LEVELS)[number]
const SCALE = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
type ChineseMode = 'review' | 'auto' | 'off'
type CheckWhen = 'before' | 'after' | 'off'

type Settings = {
  isOn: boolean
  level: Level | 'auto'
  goal: string
  gloss: boolean
  chinese: ChineseMode
  checkWhen: CheckWhen
  // Key points in Chinese under Claude's long replies.
  points: boolean
}

const DEFAULTS: Settings = { isOn: true, level: 'auto', goal: 'IELTS 7.5', gloss: true, chinese: 'review', checkWhen: 'before', points: true }

// Prefix that sends a prompt as typed, Chinese included.
const RAW_PREFIX = 'zh:'

// How long a check before sending may hold a message up; past it, the message is sent.
const HOLD_TIMEOUT_MS = 10_000

// How long a card stays once nothing waits on it: a checked message, an English draft.
const HIDE_CHECKED_MS = 8_000
const HIDE_DRAFT_MS = 20_000

// Auto level: the median of the last estimates the feedback check made.
const ESTIMATES_KEPT = 20
const ESTIMATES_NEEDED = 3
// A message shorter than this says too little about a level to count.
const WORDS_TO_ESTIMATE = 8

const loadSettings = async ($: EngineInterface): Promise<Settings> => {
  const saved = (await $.store.get('settings')) as Partial<Settings> | undefined
  return { ...DEFAULTS, ...(saved ?? {}) }
}

const loadEstimates = async ($: EngineInterface) => ((await $.store.get('estimates')) as string[] | undefined) ?? []

const addEstimate = async ($: EngineInterface, cefr: string) => {
  if (!(SCALE as readonly string[]).includes(cefr)) return
  await $.store.set('estimates', [...(await loadEstimates($)), cefr].slice(-ESTIMATES_KEPT))
}

const currentLevel = async ($: EngineInterface, s: Settings): Promise<Level> => {
  if (s.level !== 'auto') return s.level
  const ranks = (await loadEstimates($)).map(c => SCALE.indexOf(c as never)).sort((a, b) => a - b)
  if (ranks.length < ESTIMATES_NEEDED) return 'B1'
  const median = SCALE[ranks[Math.floor(ranks.length / 2)] ?? 2] ?? 'B1'
  return median === 'A1' ? 'A2' : median === 'C2' ? 'C1' : median
}

// "IELTS 7.5" → C1, "C1" → C1; null for a goal that names neither.
const goalLevel = (goal: string): string | null => {
  const cefr = goal.toUpperCase().match(/\b([ABC][12])\b/)
  if (cefr?.[1]) return cefr[1]
  const ielts = goal.match(/ielts\s*(\d+(?:\.\d)?)/i)
  if (!ielts?.[1]) return null
  const band = Number(ielts[1])
  return band >= 8.5 ? 'C2' : band >= 7 ? 'C1' : band >= 5.5 ? 'B2' : band >= 4 ? 'B1' : 'A2'
}

const publishLevel = async ($: EngineInterface, s: Settings) => {
  const samples = (await loadEstimates($)).length
  const view: LevelView = {
    isOn: s.isOn,
    level: await currentLevel($, s),
    isMeasuring: s.level === 'auto' && samples < ESTIMATES_NEEDED,
    samples: Math.min(samples, ESTIMATES_NEEDED),
    needed: ESTIMATES_NEEDED,
    goal: s.goal,
    goalLevel: goalLevel(s.goal),
  }
  await update($, levelView, () => view)
}

const levelLabel = async ($: EngineInterface, s: Settings) => {
  const level = await currentLevel($, s)
  if (s.level !== 'auto') return level
  const n = (await loadEstimates($)).length
  return n < ESTIMATES_NEEDED ? `${level}? (measuring)` : `~${level}`
}

const saveSettings = async ($: EngineInterface, s: Settings) => {
  await $.store.set('settings', s)
  await publishLevel($, s)
}

const isPerson = (origin: PromptOrigin) =>
  origin.kind === 'composer' ||
  origin.kind === 'bridge' ||
  (origin.kind === 'plugin' && origin.asUser === true && origin.name !== 'english-coach')

// Placeholders the box puts in for pasted images and long pastes.
const PLACEHOLDERS = /\[(?:Image|Pasted text) #\d+[^\]]*\]/g

// File references, whose Chinese must stay as it is: an @-mention (quoted when it holds spaces),
// a quoted path, a path with spaces in it up to its file name, a bare file name.
const FILE_REFS = [
  /@"[^"\n]*"|@\S+/g,
  /(["“'‘「])[^"”'’」\n]*[\/\\][^"”'’」\n]*["”'’」]/g,
  /(?<![\p{L}\p{N}])(?:~|\.{1,2}|[A-Za-z]:)?[\/\\][^\n]*?\.[A-Za-z0-9]{1,8}(?![\p{L}\p{N}])/gu,
  /[^\s"“”'‘’「」()（）<>]+\.[A-Za-z0-9]{1,8}(?![\p{L}\p{N}])/gu,
]

// Code, inline code, URLs, file references, paths and placeholders are not the person's prose.
const prose = (text: string) =>
  FILE_REFS.reduce(
    (t, re) => t.replace(re, ' '),
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(PLACEHOLDERS, ' ')
      .replace(/https?:\/\/\S+/g, ' '),
  ).replace(/\S*[\/\\]\S*/g, ' ')

// Quoted text is kept as it is, so Chinese in quotes alone does not make a message Chinese.
const QUOTED = /"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』/g

const hasChinese = (text: string) => /[㐀-鿿]/.test(prose(text).replace(QUOTED, ' '))

const wordCount = (text: string) => (prose(text).match(/[A-Za-z]+(?:'[a-z]+)?/g) ?? []).length

const isCheckable = (text: string) => wordCount(text) >= 3 && text.length <= 800

type Piece = { text: string; kind: 'same' | 'del' | 'add' }

const tokenize = (text: string) => text.match(/[\p{L}\p{N}'’-]+|[^\s\p{L}\p{N}]/gu) ?? []

// Word diff of the person's text against the better one, by longest common subsequence.
export const diffWords = (from: string, to: string): Piece[] => {
  const a = tokenize(from)
  const b = tokenize(to)
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)

  const ops: { tok: string; kind: Piece['kind'] }[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ tok: a[i++]!, kind: 'same' }), j++
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) ops.push({ tok: b[j++]!, kind: 'add' })
    else ops.push({ tok: a[i++]!, kind: 'del' })
  }

  // Each run of changes is drawn whole: what goes first, then what replaces it.
  const ordered: typeof ops = []
  let run: typeof ops = []
  const flush = () => {
    ordered.push(...run.filter(o => o.kind === 'del'), ...run.filter(o => o.kind === 'add'))
    run = []
  }
  for (const o of ops) {
    if (o.kind === 'same') flush(), ordered.push(o)
    else run.push(o)
  }
  flush()

  const pieces: Piece[] = []
  ordered.forEach(({ tok, kind }, k) => {
    const text = k === 0 || /^[,.!?;:)\]}%’]/.test(tok) ? tok : ` ${tok}`
    const last = pieces.at(-1)
    if (last?.kind === kind) last.text += text
    else pieces.push({ text, kind })
  })
  return pieces
}

const parseJson = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

const ask = async ($: EngineInterface, system: string, prompt: string, timeoutMs = 20_000) => {
  const r = await $.model.complete({ model: 'haiku', system, prompt, effort: 'low', maxTokens: 800, timeoutMs })
  return r.isAnswered ? parseJson(r.text) : null
}

const translate = async ($: EngineInterface, text: string, level: Level) => {
  const json = await ask(
    $,
    `You turn a learner's message, written in Chinese or mixed Chinese and English, into the English they meant to write. ` +
      `Write natural, plain English a CEFR ${level} learner can read. Keep code, commands, identifiers, file paths, URLs and quoted text exactly as they are. ` +
      `Keep the intent and tone; do not answer the message. ` +
      `Reply with JSON only: {"english": "<the message in English>", "phrases": [{"zh": "<Chinese phrase from the message>", "en": "<its English in your version>"}]} ` +
      `with up to 4 phrases worth learning.`,
    text,
  )
  if (!json || typeof json.english !== 'string' || !json.english.trim()) return null
  const phrases: Phrase[] = Array.isArray(json.phrases)
    ? json.phrases
        .filter((p: any) => typeof p?.zh === 'string' && typeof p?.en === 'string')
        .slice(0, 4)
        .map((p: any) => ({ zh: p.zh, en: p.en }))
    : []
  return { english: json.english.trim(), phrases }
}

// The end of Claude's last reply: what the person's message answers.
const lastReply = async ($: EngineInterface) => {
  try {
    const messages = await $.session.messages()
    const reply = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')
    return reply?.text.slice(-1500) ?? ''
  } catch {
    return ''
  }
}

// Words that say who does what: a fix must not change them.
const PERSONS = /\b(i|me|my|mine|you|your|yours|we|us|our|ours|he|him|his|she|her|they|them|their)\b/gi
const persons = (t: string) => (t.match(PERSONS) ?? []).map(w => w.toLowerCase()).join(' ')
// What a fix must change beyond casing and punctuation; an apostrophe is spelling (dont → don't).
const bare = (t: string) => t.toLowerCase().replace(/’/g, "'").replace(/[\s.,!?;:"]/g, '')

export type Fix = { wrong: string; right: string; tip: string }

// The model's fixes the mod trusts: each a real error, quoted exactly, changing more
// than casing or punctuation and never who does what. Applied left to right, no overlaps.
export const applyFixes = (text: string, raw: unknown) => {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const candidates = (Array.isArray(raw) ? raw : [])
    .map((f: any) => ({ wrong: str(f?.wrong), right: str(f?.right), tip: str(f?.tip).trim(), type: str(f?.type).toLowerCase() }))
    .filter(f => f.wrong.trim() !== '' && f.type !== 'style' && text.includes(f.wrong))
    .filter(f => bare(f.wrong) !== bare(f.right) && persons(f.wrong) === persons(f.right))
    .map(f => ({ ...f, at: text.indexOf(f.wrong) }))
    .sort((x, y) => x.at - y.at)

  const fixes: Fix[] = []
  let better = ''
  let from = 0
  for (const f of candidates) {
    if (f.at < from) continue
    better += text.slice(from, f.at) + f.right
    from = f.at + f.wrong.length
    fixes.push({ wrong: f.wrong, right: f.right, tip: f.tip })
  }
  return { better: better + text.slice(from), fixes }
}

const check = async ($: EngineInterface, text: string, s: Settings, level: Level, timeoutMs?: number) => {
  const context = await lastReply($)
  const message = text.replace(PLACEHOLDERS, '').trim()
  const json = await ask(
    $,
    `You check the English of a message a Chinese-speaking learner (around CEFR ${level}, goal ${s.goal}) is about to send to an AI assistant, Claude. ` +
      `In it "you" is Claude and "I" is the learner. Ignore code, paths and commands. Claude's previous reply may be shown so you know what they mean; never judge it. ` +
      `List only real errors: wrong grammar, a wrong word, a misspelling, or a collocation a native reader would stumble on. ` +
      `Do not list what is merely less elegant, casing, punctuation or a missing final period. If the message reads fine, list nothing. ` +
      `For each error: "wrong" is the shortest span copied character for character from the message, "right" is that span corrected with the smallest change, ` +
      `keeping the meaning and who does what; "type" is grammar, word, spelling or collocation; "tip" says why in Simplified Chinese, under 30 characters, and must be true of this message. ` +
      `Separately, give one "upgrade": a more precise or higher-level word, collocation or structure a ${s.goal} candidate would use for part of the message, written "plain → better" (empty if nothing fits). ` +
      `Estimate the CEFR level (A1, A2, B1, B2, C1 or C2) the message shows. ` +
      `Reply with JSON only: {"errors": [{"wrong": "<exact span>", "right": "<fix>", "type": "<type>", "tip": "<中文>"}], "upgrade": "<plain → better, or empty>", "cefr": "<level>"}`,
    (context ? `Claude's previous reply (context only):\n"""\n${context}\n"""\n\n` : '') +
      `The learner's message to check:\n"""\n${message}\n"""`,
    timeoutMs,
  )
  if (!json || !Array.isArray(json.errors)) return null
  const { better, fixes } = applyFixes(text, json.errors)
  return {
    isNatural: fixes.length === 0,
    better: fixes.length === 0 ? '' : better,
    tips: fixes.map(f => f.tip).filter(Boolean).slice(0, 3),
    upgrade: typeof json.upgrade === 'string' ? json.upgrade.trim() : '',
    cefr: typeof json.cefr === 'string' ? json.cefr.trim().toUpperCase() : '',
  }
}

// Only the language Claude writes in: everything else the mod does after the reply.
const systemSection = () =>
  [
    `# English`,
    `Write every reply in English, even when the person writes in Chinese. Code, commands and quoted text stay as they are.`,
  ].join('\n')

const pickGlosses = async ($: EngineInterface, text: string, level: Level, s: Settings, known: string[]): Promise<Gloss[]> => {
  const json = await ask(
    $,
    `You help a Chinese-speaking English learner, around CEFR ${level} and aiming for ${s.goal}, read an English reply. ` +
      `Pick up to ${GLOSSES_PER_BLOCK} words or phrases in it that are likely above ${level} and worth learning: rare words, idioms, phrasal verbs, collocations, technical terms whose meaning is not obvious. ` +
      `Copy each term exactly as it appears in the text, outside code. Skip code identifiers, file names, commands, product names` +
      (known.length ? `, and these terms the learner has already seen glossed: ${known.join(', ')}` : '') +
      `. Give each a short Simplified Chinese gloss of its meaning here, 2 to 8 characters. ` +
      `Reply with JSON only: {"glosses": [{"term": "<exact text>", "zh": "<释义>"}]}`,
    text.slice(0, 6000),
  )
  if (!json || !Array.isArray(json.glosses)) return []
  return json.glosses
    .filter((g: any) => typeof g?.term === 'string' && typeof g?.zh === 'string' && g.term.trim() && g.zh.trim())
    .slice(0, GLOSSES_PER_BLOCK)
    .map((g: any) => ({ term: g.term.trim(), zh: g.zh.trim() }))
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Puts "term（释义）" after the first use of each term, outside code, links and URLs.
const applyGlosses = (markdown: string, glosses: Gloss[]) => {
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)|https?:\/\/\S+)/)
  const done = new Set<string>()
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      let out = part
      for (const g of glosses) {
        const key = g.term.toLowerCase()
        if (done.has(key)) continue
        const re = new RegExp(`(?<![\\p{L}\\p{N}])(${escapeRegExp(g.term)})(?![\\p{L}\\p{N}（])`, 'iu')
        if (!re.test(out)) continue
        done.add(key)
        out = out.replace(re, `$1（${g.zh}）`)
      }
      return out
    })
    .join('')
}

// /zh keeps at most this many replies translated, and translates this many paragraphs at once.
const ZH_KEPT = 20
const ZH_AT_ONCE = 4

const FENCE = /^\s*(```|~~~)/

// A reply's paragraphs: blank lines part them, and a code block, blank lines and all, is one.
export const paragraphs = (text: string) => {
  const out: string[] = []
  let lines: string[] = []
  let isInCode = false
  const end = () => {
    const p = lines.join('\n').trim()
    if (p) out.push(p)
    lines = []
  }
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      if (!isInCode) end()
      lines.push(line)
      isInCode = !isInCode
      if (!isInCode) end()
    } else if (!isInCode && line.trim() === '') end()
    else lines.push(line)
  }
  end()
  return out
}

const isCode = (para: string) => FENCE.test(para)

// Claude's replies, oldest first: what it wrote after each of the person's prompts, tool output left out.
export const repliesOf = (messages: readonly SessionMessage[]) => {
  const out: string[] = []
  let texts: string[] = []
  const end = () => {
    if (texts.length) out.push(texts.join('\n\n'))
    texts = []
  }
  for (const m of messages) {
    if (m.role === 'user' && !m.toolResults?.length) end()
    else if (m.role === 'assistant' && m.text.trim()) texts.push(m.text)
  }
  end()
  return out
}

const sameReply = (t: { paras: string[] }, paras: string[]) => t.paras.length === paras.length && t.paras.every((p, i) => p === paras[i])

const translatePara = async ($: EngineInterface, para: string, before: string) => {
  const r = await $.model.complete({
    model: 'haiku',
    system:
      `You translate a paragraph of a reply that Claude, an AI coding assistant, wrote to a Chinese-speaking developer, into natural Simplified Chinese. ` +
      `Translate all of it faithfully: never summarize, add or leave out anything. ` +
      `Keep markdown (lists, bold, headings, tables), inline code, file paths, commands, identifiers and URLs exactly as they are. ` +
      `Give a technical term as its usual Chinese term with the English in full-width brackets the first time it appears, e.g. 竞态条件（race condition）; keep product names in English. ` +
      `Reply with the translation only.`,
    prompt: (before ? `The paragraph before it, for context only:\n"""\n${before}\n"""\n\n` : '') + `Translate this paragraph:\n"""\n${para}\n"""`,
    effort: 'low',
    maxTokens: 2000,
    timeoutMs: 30_000,
  })
  if (!r.isAnswered) return null
  return r.text.trim().replace(/^"""\s*|\s*"""$/g, '').trim() || null
}

// Paragraphs Haiku is translating now, so a second /zh does not ask for them again.
const translating = new Set<string>()

// Translates the paragraphs of a reply that have no Chinese yet, a few at a time, top first.
const translateMissing = async ($: EngineInterface, paras: string[]) => {
  const entry = (await read($, translations)).find(t => sameReply(t, paras))
  if (!entry) return
  const todo = entry.zh.flatMap((zh, i) => (zh === null && !translating.has(paras[i]!) ? [i] : []))
  todo.forEach(i => translating.add(paras[i]!))
  let k = 0
  const work = async () => {
    while (k < todo.length) {
      const i = todo[k++]!
      const zh = await translatePara($, paras[i]!, paras[i - 1] ?? '')
      translating.delete(paras[i]!)
      await update($, translations, list =>
        list.map(t => (sameReply(t, paras) ? { ...t, zh: t.zh.map((was, j) => (j === i ? (zh ?? false) : was)) } : t)),
      )
    }
  }
  await Promise.all(Array.from({ length: ZH_AT_ONCE }, () => work()))
}

// The Chinese drawn under a reply block: its paragraphs' translations, from a reply /zh shows.
const chineseFor = (list: readonly ReplyTranslation[], text: string): string | null => {
  const paras = paragraphs(text)
  if (paras.length === 0) return null
  for (const t of [...list].reverse()) {
    if (!t.isShown) continue
    const at = paras.map(p => t.paras.indexOf(p))
    if (at.some(i => i < 0)) continue
    return at
      .map(i => {
        const zh = t.zh[i]
        return zh === '' ? '〔代码见上〕' : zh === null ? '…' : zh === false ? '（这一段没翻译成功，再输入 /zh 重试）' : zh
      })
      .join('\n\n')
  }
  return null
}

// A reply this long, in English words outside code, gets key points under it; this many replies are kept.
const POINTS_MIN_WORDS = 150
const POINTS_KEPT = 20

const makePoints = async ($: EngineInterface, reply: string) => {
  // What was done comes first in a reply and the question last, so a very long one keeps both ends.
  const text = reply.length > 12_000 ? `${reply.slice(0, 3_000)}\n\n[…]\n\n${reply.slice(-9_000)}` : reply
  const json = await ask(
    $,
    `You help a Chinese-speaking developer, who reads long English slowly, follow a reply that Claude, an AI coding assistant, wrote to them. ` +
      `Give the reply's key points in Simplified Chinese, so they know what it says before reading it all. ` +
      `"did": what Claude did in this turn (files changed, commands run, tests and their results), in one sentence; empty if it only explained or answered. ` +
      `"point": the reply's main conclusion, answer or recommendation, in one sentence. ` +
      `"ask": the question Claude asks them, or the decision or action it needs from them, in one sentence; empty if the reply asks nothing, and never make one up. ` +
      `Each one short sentence under 50 characters: only what matters most, plain text, no markdown. Keep file names, commands, identifiers and numbers as they are, and technical terms in English where a Chinese developer would. ` +
      `Say only what the reply says. Reply with JSON only: {"did": "<中文>", "point": "<中文>", "ask": "<中文>"}`,
    `The reply:\n"""\n${text}\n"""`,
    30_000,
  )
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const points = { did: str(json?.did), point: str(json?.point), ask: str(json?.ask) }
  return points.did || points.point || points.ask ? points : null
}

// Key points for Claude's last reply, if it is long and has none yet.
const pointLastReply = async ($: EngineInterface) => {
  const s = await loadSettings($)
  if (!s.isOn || !s.points) return
  const reply = repliesOf(await $.session.messages()).at(-1)
  if (reply === undefined || wordCount(reply) < POINTS_MIN_WORDS) return
  const paras = paragraphs(reply)
  if ((await read($, keyPoints)).some(p => sameReply(p, paras))) return
  await update($, keyPoints, all => [...all, { paras, points: null }].slice(-POINTS_KEPT))
  const points = await makePoints($, reply)
  // Nothing is drawn for a reply Haiku could not read.
  await update($, keyPoints, all =>
    points ? all.map(p => (sameReply(p, paras) ? { ...p, points } : p)) : all.filter(p => !sameReply(p, paras)),
  )
}

// The key points drawn under a reply block: those of the reply the block ends.
const pointsFor = (list: readonly ReplyPoints[], text: string) => {
  const paras = paragraphs(text)
  const last = paras.at(-1)
  return [...list].reverse().find(p => p.paras.at(-1) === last && paras.every(q => p.paras.includes(q)))
}

// What goes under a reply, as markdown added to its text: the desktop draws a reply as its text alone
// in places, where a tree of ours would be dropped.
const quoted = (markdown: string) => markdown.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n')

const zhMarkdown = (zh: string) => quoted(`**中文** · /zh hides it\n\n${zh}`)

const pointsMarkdown = (p: ReplyPoints['points']) => {
  const rows = p ? [p.did && `- **做了**　${p.did}`, p.point && `- **结论**　${p.point}`, p.ask && `- **问你　${p.ask}**`] : ['…']
  return quoted(['**要点** · /zh 看全文中文', ...rows.filter(Boolean)].join('\n'))
}

const HELP = async ($: EngineInterface, s: Settings) =>
  [
    `English coach is ${s.isOn ? 'on' : 'off'} · level ${await levelLabel($, s)} · goal ${s.goal} · glosses ${s.gloss ? 'on' : 'off'} · key points ${s.points ? 'on' : 'off'} · Chinese input: ${s.chinese} · feedback ${s.checkWhen}`,
    ``,
    `/english on | off              turn the mode on or off`,
    `/english level auto            measure your level from what you write (default)`,
    `/english level A2|B1|B2|C1     fix the level of Claude's English`,
    `/english goal <text>           your target, e.g. IELTS 7.5`,
    `/english gloss on|off          Chinese glosses after hard words`,
    `/english points on|off         key points in Chinese under Claude's long replies`,
    `/english chinese review        Chinese input becomes an English draft in the box for you to check (default)`,
    `/english chinese auto          Chinese input is translated and sent at once`,
    `/english chinese off           Chinese input is sent as typed`,
    `/english feedback before       check your English when you press Enter; the fix goes in the box (default)`,
    `/english feedback after        send at once, show the feedback afterwards`,
    `/english feedback off          no feedback on your English`,
    `/english demo                  show a sample feedback card`,
    `/en <text>                     turn Chinese or rough English into an English draft in the box`,
    `/zh                            Chinese translation of Claude's last reply, under it; again hides it (/zh 2: the reply before)`,
    `Start a prompt with "${RAW_PREFIX}" to send it as typed.`,
  ].join('\n')

const DEMO: Feedback = {
  kind: 'checked',
  isNatural: false,
  original: 'The 135 score is in college entrance exam, and i made a mistake. The suggestions only shows when the message is send.',
  better: 'The 135 score is from the college entrance exam, and I made a mistake. The suggestions only appear when the message is sent.',
  tips: ['表示来源用 from，不用 in', 'suggestions 是复数，动词用 appear', '被动语态：is sent，不是 is send'],
  upgrade: 'only appear when → only show up once',
  isHeld: true,
}

const applyArgs = (s: Settings, args: string): Settings | string => {
  const trimmed = args.trim()
  const [key = '', value = ''] = trimmed.toLowerCase().split(/\s+/)
  const flag = value === 'on' ? true : value === 'off' ? false : undefined
  if (key === 'on' || key === 'off') return { ...s, isOn: key === 'on' }
  if (key === 'level') {
    if (value === 'auto') return { ...s, level: 'auto' }
    const level = value.toUpperCase() as Level
    return LEVELS.includes(level) ? { ...s, level } : `Level must be auto or one of ${LEVELS.join(', ')}.`
  }
  if (key === 'goal') {
    const goal = trimmed.slice(4).trim()
    return goal ? { ...s, goal } : 'Give a goal, e.g. /english goal IELTS 7.5'
  }
  if (key === 'gloss' && flag !== undefined) return { ...s, gloss: flag }
  if (key === 'points' && flag !== undefined) return { ...s, points: flag }
  if (key === 'feedback') {
    const when = value === 'on' ? 'before' : value
    if (when === 'before' || when === 'after' || when === 'off') return { ...s, checkWhen: when }
  }
  if (key === 'chinese' && (value === 'review' || value === 'auto' || value === 'off')) return { ...s, chinese: value }
  return `Unknown option "${trimmed}".`
}

// Reply blocks drawn, newest last, with their latest text; and terms already glossed.
const seen = new Map<string, string>()
const glossedTerms = new Set<string>()

const glossNewBlocks = async ($: EngineInterface) => {
  const s = await loadSettings($)
  if (!s.isOn || !s.gloss) return
  const level = await currentLevel($, s)
  const made = await read($, replyGlosses)
  const todo = [...seen].filter(([id, text]) => made[id]?.text !== text && text.trim().length >= 40).slice(-BLOCKS_PER_TURN)
  for (const [id, text] of todo) {
    const glosses = await pickGlosses($, text, level, s, [...glossedTerms].slice(-100))
    glosses.forEach(g => glossedTerms.add(g.term.toLowerCase()))
    await update($, replyGlosses, all => {
      const next = { ...all, [id]: { text, glosses } }
      const ids = Object.keys(next)
      for (const old of ids.slice(0, Math.max(0, ids.length - GLOSSED_KEPT))) delete next[old]
      return next
    })
  }
}

// Hides the card later, unless another one has taken its place by then.
const hideLater = ($: EngineInterface, card: Feedback, ms: number) => {
  const was = JSON.stringify(card)
  $.clock.after(ms, () => void update($, feedback, shown => (JSON.stringify(shown) === was ? null : shown)))
}

// The key that swaps a held message between the fix and the person's own: the engine keeps
// Tab and the arrows, so a mod sees only typed characters. Backtick, by Tab; Chinese input
// methods type that key as "·", "、" or a full-width "｀".
const SWAP_KEY = '`'
const SWAP_TYPED = new Set([SWAP_KEY, '·', '、', '｀'])
const isSwap = (typed: string) => SWAP_TYPED.has(typed)

// A message waiting in the box, a held fix or an English draft: the version in the box now,
// the one a swap puts there, and the card once swapped.
type Waiting = { now: string; other: string; swapped: Feedback }

const waiting = (fb: Feedback | null): Waiting | null => {
  if (fb?.kind === 'checked' && fb.isHeld) {
    const isFix = fb.inBox === 'better'
    return { now: isFix ? fb.better : fb.original, other: isFix ? fb.original : fb.better, swapped: { ...fb, inBox: isFix ? 'original' : 'better' } }
  }
  if (fb?.kind === 'translated' && fb.inBox) {
    const isEnglish = fb.inBox === 'english'
    return { now: isEnglish ? fb.english : fb.original, other: isEnglish ? fb.original : fb.english, swapped: { ...fb, inBox: isEnglish ? 'chinese' : 'english' } }
  }
  return null
}

// The card once its message is sent: nothing waits on it any more.
const settled = (fb: Feedback): Feedback =>
  fb.kind === 'checked'
    ? { ...fb, isHeld: false }
    : fb.kind === 'translated'
      ? { kind: 'translated', original: fb.original, english: fb.english, phrases: fb.phrases }
      : fb

// Turns the card of a waiting message to its other version; returns that version's text for the box.
const swapCard = async ($: EngineInterface, w: Waiting) => {
  await update($, feedback, shown => waiting(shown)?.swapped ?? shown)
  return w.other
}

// The card's button: the other version into the box, whatever the box has now. Returns it, or null.
const swapBox = async ($: EngineInterface) => {
  const w = waiting(await read($, feedback))
  if (w === null) return null
  const text = await swapCard($, w)
  await $.prompt.fill({ text })
  return text
}

// An English draft into the box, its card waiting on it until something is sent.
const showDraft = async ($: EngineInterface, original: string, t: { english: string; phrases: Phrase[] }) => {
  await update($, feedback, (): Feedback => ({ kind: 'translated', original, ...t, inBox: 'english' }))
  $.clock.after(50, () => void $.prompt.fill({ text: t.english }))
}

export const register: Register = on => {
  // The text a waiting message has in the box: Enter on it sends it as it is.
  let held: string | null = null
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'english',
      description: 'English coach: show or change its settings',
      argumentHint: '[on|off|level auto|goal IELTS 7.5|gloss on|chinese review|feedback before|demo]',
    })
    await $.command.register({
      name: 'en',
      description: 'Turn Chinese or rough English into an English draft in the prompt box',
      argumentHint: '<text>',
    })
    await $.command.register({
      name: 'zh',
      description: "Chinese translation of Claude's last reply, drawn under it for you alone; again hides it",
      argumentHint: '[2 for the reply before, 3, …]',
    })
    // The level is drawn under the prompt now; clear the status line of earlier versions.
    $.ui.status(undefined)
    await publishLevel($, await loadSettings($))
    return next(e)
  })

  on('command.run', { command: 'english' }, async ($, e) => {
    const s = await loadSettings($)
    if (!e.args.trim()) return { text: await HELP($, s) }
    if (e.args.trim().toLowerCase() === 'demo') {
      await update($, feedback, () => DEMO)
      return { text: 'A sample feedback card is above the prompt. Press ✕ to close it.' }
    }
    const changed = applyArgs(s, e.args)
    if (typeof changed === 'string') return { text: `${changed}\n\n${await HELP($, s)}` }
    await saveSettings($, changed)
    if (!changed.isOn) await update($, feedback, () => null)
    // Settings are not state a drawn reply follows, so points already drawn go with the points made.
    if (!changed.isOn || !changed.points) await update($, keyPoints, () => [])
    return { text: (await HELP($, changed)).split('\n')[0] ?? '' }
  })

  on('command.run', { command: 'en' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: 'Usage: /en <Chinese or rough English>' }
    const s = await loadSettings($)
    const t = await translate($, text, await currentLevel($, s))
    if (!t) return { text: 'Could not make an English draft just now. Try again.' }
    held = t.english
    await showDraft($, text, t)
    return { text: 'English draft is in the prompt box: edit it, then press Enter.' }
  })

  // The translation is drawn under the reply, never printed as the command's output, which can go into what Claude reads.
  on('command.run', { command: 'zh' }, async ($, e) => {
    const arg = e.args.trim()
    const back = arg === '' ? 1 : Number(arg)
    if (!Number.isInteger(back) || back < 1) return { text: 'Usage: /zh, or /zh 2 for the reply before the last.' }
    const reply = repliesOf(await $.session.messages()).at(-back)
    if (reply === undefined) return { text: 'No reply from Claude to translate yet.' }

    const paras = paragraphs(reply)
    const list = await read($, translations)
    const found = list.find(t => sameReply(t, paras))
    if (found?.isShown && !found.zh.includes(false)) {
      await update($, translations, all => all.map(t => (sameReply(t, paras) ? { ...t, isShown: false } : t)))
      return {}
    }
    // Paragraphs translated before, in this reply or another, are not asked for again; failed ones are.
    const known = new Map<string, string>()
    for (const t of list)
      t.paras.forEach((p, i) => {
        const zh = t.zh[i]
        if (typeof zh === 'string' && zh !== '') known.set(p, zh)
      })
    const entry: ReplyTranslation = { paras, zh: paras.map(p => (isCode(p) ? '' : (known.get(p) ?? null))), isShown: true }
    await update($, translations, all => [...all.filter(t => !sameReply(t, paras)), entry].slice(-ZH_KEPT))
    $.clock.after(0, () => void translateMissing($, paras))
    return {}
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const s = await loadSettings($)
    if (!s.isOn) return composed
    const section = { id: 'english-coach:mode', text: systemSection(), scope: 'session' as const }
    return { sections: [...composed.sections, section] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !isPerson(e.origin)) return next(e)
    const s = await loadSettings($)
    if (!s.isOn) return next(e)

    // Anything sent settles a message waiting in the box; Enter on it as it was put there sends it
    // as it is: a fix, the person's own, an English draft or their Chinese.
    const shown = await read($, feedback)
    if (shown !== null && waiting(shown) !== null) {
      const card = settled(shown)
      await update($, feedback, () => card)
      hideLater($, card, HIDE_CHECKED_MS)
    }
    const wasHeld = held
    held = null
    if (wasHeld !== null && e.text.trim() === wasHeld.trim()) return next(e)

    if (e.text.startsWith(RAW_PREFIX)) return next({ ...e, text: e.text.slice(RAW_PREFIX.length).trimStart() })

    const level = await currentLevel($, s)

    if (s.chinese !== 'off' && hasChinese(e.text)) {
      const t = await translate($, e.text, level)
      if (!t) {
        $.ui.toast('English coach: translation failed, sent as typed.')
        return next(e)
      }
      if (s.chinese === 'auto') {
        const card: Feedback = { kind: 'translated', original: e.text, ...t }
        await update($, feedback, () => card)
        hideLater($, card, HIDE_DRAFT_MS)
        return next({ ...e, text: t.english })
      }
      held = t.english
      await showDraft($, e.text, t)
      return { drop: `Not sent: your English draft is in the box. Enter sends it; ${SWAP_KEY} or ↩ 中文 on the card brings your Chinese back.` }
    }

    if (s.checkWhen === 'off' || !isCheckable(e.text)) return next(e)

    const original = e.text
    const record = async (r: Awaited<ReturnType<typeof check>>, isHeld: boolean) => {
      if (r && wordCount(original) >= WORDS_TO_ESTIMATE) {
        await addEstimate($, r.cefr)
        await publishLevel($, s)
      }
      const card: Feedback | null = r
        ? {
            kind: 'checked',
            original,
            isNatural: r.isNatural,
            better: r.better,
            tips: r.tips,
            upgrade: r.upgrade,
            isHeld,
            ...(isHeld ? { inBox: 'better' as const } : {}),
          }
        : null
      await update($, feedback, shown => (shown?.original !== original ? shown : card))
      if (card && !isHeld) hideLater($, card, HIDE_CHECKED_MS)
    }

    // A message with images is never held: filling the box again would lose them.
    if (s.checkWhen === 'after' || (e.attachments?.length ?? 0) > 0) {
      await update($, feedback, (): Feedback => ({ kind: 'pending', original }))
      // Off the dispatch, so the turn is not held up by the check.
      $.clock.after(0, async () => record(await check($, original, s, level), false))
      return next(e)
    }

    await update($, feedback, (): Feedback => ({ kind: 'pending', original }))
    const r = await check($, original, s, level, HOLD_TIMEOUT_MS)
    const isHeld = r !== null && !r.isNatural && r.better !== '' && r.better.trim() !== original.trim()
    await record(r, isHeld)
    if (!isHeld) return next(e)

    // The fix goes straight into the box, as a Chinese draft does.
    const fixed = r.better
    held = fixed
    $.clock.after(50, () => void $.prompt.fill({ text: fixed }))
    return { drop: `Not sent yet: the corrected message is in the box. Enter sends it; ${SWAP_KEY} or ↩ Mine on the card brings yours back.` }
  })

  // The swap key on an untouched waiting message trades its versions; Enter sends either as it is.
  // In the person's Chinese, · and 、 are punctuation they may be typing: there only the button swaps.
  on('prompt.edit', async ($, e, next) => {
    if (!isSwap(e.inputText) || e.start !== e.end) return next(e)
    const fb = await read($, feedback)
    const w = waiting(fb)
    if (w === null || e.text.trim() !== w.now.trim() || (fb?.kind === 'translated' && fb.inBox === 'chinese')) return next(e)
    const text = await swapCard($, w)
    held = text
    return { text, cursor: text.length }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const fb = await read($, feedback)
    if (e.props.hasSurvey || fb === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const hide = <Button key="hide" plain label="✕" onPress={() => update($, feedback, () => null)} />

    // A click swaps too: some input methods type the swap key as punctuation the person wants.
    const card = (color: string, title: string, hint: string, swapLabel: string, ...body: RenderChildren[]) => (
      <Box key="card" flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box justifyContent="space-between">
          <Text>
            <Text color={color} bold>
              {title}
            </Text>
            <Text dimColor>{hint ? `   ${hint}` : ''}</Text>
          </Text>
          <Box gap={1}>
            {swapLabel ? (
              <Button
                key="swap"
                label={swapLabel}
                onPress={async () => {
                  const text = await swapBox($)
                  if (text !== null) held = text
                }}
              />
            ) : null}
            {hide}
          </Box>
        </Box>
        {body.filter(Boolean)}
      </Box>
    )

    if (fb.kind === 'pending') {
      return <Text dimColor>✎ Checking your English…</Text>
    }

    if (fb.kind === 'translated') {
      return card(
        'cyan',
        '中 → EN',
        fb.inBox === 'english'
          ? `Your English draft is in the box: edit it, then Enter · ${SWAP_KEY} back to your Chinese`
          : fb.inBox === 'chinese'
            ? 'Your Chinese is back: Enter sends it as typed, or edit it for a new draft'
            : 'Sent in English',
        fb.inBox === 'english' ? '↩ 中文' : fb.inBox === 'chinese' ? '→ English' : '',
        fb.phrases.length > 0 && (
          <Box key="phrases" flexDirection="column">
            {fb.phrases.map(p => (
              <Text>
                <Text dimColor>• </Text>
                {p.zh}
                <Text dimColor> → </Text>
                <Text color="cyan">{p.en}</Text>
              </Text>
            ))}
          </Box>
        ),
      )
    }

    const upgrade = fb.upgrade !== '' && (
      <Text key="upgrade">
        <Text color="magenta" bold>
          ↑{' '}
        </Text>
        {fb.upgrade}
      </Text>
    )

    // All good: one line, no border.
    if (fb.isNatural) {
      return (
        <Box key="natural" justifyContent="space-between">
          <Text>
            <Text color="green" bold>
              ✓ Natural English
            </Text>
            {upgrade ? <Text dimColor>{'   '}</Text> : ''}
            {upgrade}
          </Text>
          {hide}
        </Box>
      )
    }

    return card(
      'yellow',
      fb.isHeld && fb.inBox === 'better' ? '✎ Fixed in the box' : '✎ Almost there',
      !fb.isHeld ? '' : fb.inBox === 'better' ? `Enter send it · ${SWAP_KEY} back to yours` : `${SWAP_KEY} use the fix · Enter send yours as is`,
      !fb.isHeld ? '' : fb.inBox === 'better' ? '↩ Mine' : '✎ The fix',
      <Box key="diff">
        <Text>
          {diffWords(fb.original, fb.better).map(p =>
            p.kind === 'same' ? (
              p.text
            ) : p.kind === 'del' ? (
              <Text color="red" strikethrough>
                {p.text}
              </Text>
            ) : (
              <Text color="green" bold>
                {p.text}
              </Text>
            ),
          )}
        </Text>
      </Box>,
      fb.tips.length > 0 && (
        <Box key="tips" flexDirection="column">
          {fb.tips.map((tip, i) => (
            <Text>
              {i === 0 ? '💡 ' : '   '}
              {fb.tips.length > 1 ? <Text dimColor>{i + 1}. </Text> : ''}
              {tip}
            </Text>
          ))}
        </Box>
      ),
      upgrade,
    )
  })

  // Glosses and key points are made once the turn's reply is whole, off the dispatch.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) $.clock.after(300, () => void Promise.all([glossNewBlocks($), e.isAborted ? null : pointLastReply($)]))
    return done
  })

  // Draws a reply with its glosses and, under it, its Chinese after /zh or else the key points of a long one:
  // a tree on the terminal, markdown added to the drawn text elsewhere. The stored reply, which Claude reads, is unchanged.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    seen.delete(e.requestId)
    seen.set(e.requestId, e.props.text)
    if (seen.size > 200) seen.delete(seen.keys().next().value!)

    const s = await loadSettings($)
    const made = (await read($, replyGlosses))[e.requestId]
    const isGlossed = s.isOn && s.gloss && made?.text === e.props.text && made.glosses.length > 0
    const reply = isGlossed && made ? { ...e, props: { ...e.props, text: applyGlosses(e.props.text, made.glosses) } } : e

    const zh = chineseFor(await read($, translations), e.props.text)
    const found = zh === null && s.isOn && s.points ? pointsFor(await read($, keyPoints), e.props.text) : undefined
    if (zh === null && found === undefined) return next(reply)
    if (e.surface !== 'terminal') {
      const under = zh !== null ? zhMarkdown(zh) : pointsMarkdown(found?.points ?? null)
      return next({ ...reply, props: { ...reply.props, text: `${reply.props.text}\n\n${under}` } })
    }
    const { Box, Markdown, Text } = $.ui.resolve(e)
    if (zh !== null)
      return (
        <Box key="with-zh" flexDirection="column">
          {await next(reply)}
          <Box key="zh" flexDirection="column" paddingLeft={2}>
            <Text dimColor>── 中文 · /zh hides it ──</Text>
            <Markdown key="zh-text" text={zh} dimColor />
          </Box>
        </Box>
      )
    const p = found?.points
    // The label and its text side by side, so a long line wraps under its text; the question stands out.
    const row = (key: string, label: string, text: string) => {
      const look = key === 'ask' ? { color: 'yellow', bold: true } : {}
      return text ? (
        <Box key={key}>
          <Text {...look} dimColor={key !== 'ask'}>{`${label}  `}</Text>
          <Text {...look}>{text}</Text>
        </Box>
      ) : null
    }
    return (
      <Box key="with-points" flexDirection="column">
        {await next(reply)}
        <Box key="points" flexDirection="column" paddingLeft={2}>
          <Text>
            <Text color="cyan">── 要点 </Text>
            <Text dimColor>· /zh 看全文中文 ──</Text>
          </Text>
          {p ? (
            [row('did', '做了', p.did), row('point', '结论', p.point), row('ask', '问你', p.ask)]
          ) : (
            <Text key="reading" dimColor>
              …
            </Text>
          )}
        </Box>
      </Box>
    )
  })

  // The level slider, at the right of the footer under the prompt.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const v = await read($, levelView)
    if (!v?.isOn) return next(e)

    const { Text } = $.ui.resolve(e)
    // The desktop cuts the footer label short: there, only the stretch from the level to the goal.
    const isNarrow = e.surface !== 'terminal'
    const here = SCALE.indexOf(v.level as never)
    const goal = v.goalLevel ? SCALE.indexOf(v.goalLevel as never) : -1
    const shown = isNarrow ? SCALE.slice(Math.min(here, goal < 0 ? here : goal), Math.max(here, goal) + 1) : SCALE
    const marks = shown.flatMap((c, i) => {
      const isYou = c === v.level
      const isGoal = c === v.goalLevel
      const mark = isYou ? (
        <Text color="cyan" bold inverse>
          {` ${c}${v.isMeasuring ? '?' : ''}${isGoal ? '★' : ''} `}
        </Text>
      ) : isGoal ? (
        <Text color="magenta" bold>
          {`${c}★`}
        </Text>
      ) : (
        <Text dimColor>{c}</Text>
      )
      return i === 0 ? [mark] : [<Text dimColor>─</Text>, mark]
    })

    return (
      <Text>
        {e.props.modes.length > 0 ? <Text dimColor>{`${e.props.modes.join(' & ')} · `}</Text> : ''}
        <Text dimColor>EN </Text>
        {marks}
        {v.isMeasuring && !isNarrow ? <Text dimColor>{` measuring ${v.samples}/${v.needed}`}</Text> : ''}
      </Text>
    )
  })
}
