import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderChildren } from 'claude-code'

import type { Feedback, Gloss, LevelView, Phrase, ReplyGlosses } from '../types'

const feedback = atom({ plugin: 'english-coach', key: 'feedback' } as const, null)
const levelView = atom({ plugin: 'english-coach', key: 'level' } as const, null)
const replyGlosses = atom({ plugin: 'english-coach', key: 'glosses' } as const, {} as ReplyGlosses)

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
}

const DEFAULTS: Settings = { isOn: true, level: 'auto', goal: 'IELTS 7.5', gloss: true, chinese: 'review', checkWhen: 'before' }

// Prefix that sends a prompt as typed, Chinese included.
const RAW_PREFIX = 'zh:'

// How long a check before sending may hold a message up; past it, the message is sent.
const HOLD_TIMEOUT_MS = 10_000

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

// Code, inline code, URLs and paths are not the person's prose.
const prose = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S*[\/\\]\S*/g, ' ')

const hasChinese = (text: string) => /[㐀-鿿]/.test(prose(text))

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

const check = async ($: EngineInterface, text: string, s: Settings, level: Level, timeoutMs?: number) => {
  const context = await lastReply($)
  const json = await ask(
    $,
    `You coach a Chinese-speaking English learner, now around CEFR ${level}, whose goal is ${s.goal}. They are chatting with an AI assistant, Claude, ` +
      `and you judge the English of the message they are about to send it (ignore code, paths, commands). In their message "you" is Claude and "I" is the learner. ` +
      `You may be shown Claude's previous reply, only so you understand what they mean; never judge it. ` +
      `"better" fixes real errors only: grammar, a wrong word, a collocation a native reader would stumble on. Make the smallest edit that fixes each one. ` +
      `Never change the meaning, who does what (I, you, we), the question asked, names, facts or tone, and never paraphrase, merge or split a sentence that is already correct. ` +
      `If there is no real error, set "natural" true, even if it could be more elegant: style ideas belong in "upgrade". Ignore casing, a missing final period and other tiny slips. ` +
      `For each real error give a tip in Simplified Chinese, at most 3, each under 30 characters. ` +
      `Whether natural or not, offer one "upgrade": a more precise or higher-level word, collocation or structure that a ${s.goal} candidate would use for part of the message, written "plain → better" (empty if nothing fits). ` +
      `Also estimate the CEFR level (A1, A2, B1, B2, C1 or C2) this message shows. ` +
      `Reply with JSON only: {"natural": true|false, "better": "<improved message, or empty>", "tips": ["<中文提示>"], "upgrade": "<plain → better, or empty>", "cefr": "<level>"}`,
    (context ? `Claude's previous reply (context only):\n\"\"\"\n${context}\n\"\"\"\n\n` : '') +
      `The learner's message to judge:\n\"\"\"\n${text}\n\"\"\"`,
    timeoutMs,
  )
  if (!json || typeof json.natural !== 'boolean') return null
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const tips = Array.isArray(json.tips) ? json.tips.map(str).filter(Boolean).slice(0, 3) : [str(json.tip)].filter(Boolean)
  return {
    isNatural: json.natural,
    better: str(json.better),
    tips,
    upgrade: str(json.upgrade),
    cefr: str(json.cefr).toUpperCase(),
  }
}

// Kept light on purpose: glosses are added to the drawing afterwards, so Claude's
// own writing carries no learner rules beyond the language it writes in.
const systemSection = (s: Settings, level: Level) =>
  [
    `# English learning mode`,
    `The person is a Chinese-speaking English learner (around CEFR ${level}, aiming for ${s.goal}) practising English with you.`,
    `- Write every reply in English, even when they write in Chinese. Code, commands and quoted text stay as they are.`,
    `- Where it costs nothing in accuracy, prefer clear, plain wording.`,
    `- A separate tool gives them feedback on their English and glosses hard words in your replies; do not correct their English or add translations unless they ask.`,
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

const HELP = async ($: EngineInterface, s: Settings) =>
  [
    `English coach is ${s.isOn ? 'on' : 'off'} · level ${await levelLabel($, s)} · goal ${s.goal} · glosses ${s.gloss ? 'on' : 'off'} · Chinese input: ${s.chinese} · feedback ${s.checkWhen}`,
    ``,
    `/english on | off              turn the mode on or off`,
    `/english level auto            measure your level from what you write (default)`,
    `/english level A2|B1|B2|C1     fix the level of Claude's English`,
    `/english goal <text>           your target, e.g. IELTS 7.5`,
    `/english gloss on|off          Chinese glosses after hard words`,
    `/english chinese review        Chinese input becomes an English draft in the box for you to check (default)`,
    `/english chinese auto          Chinese input is translated and sent at once`,
    `/english chinese off           Chinese input is sent as typed`,
    `/english feedback before       check your English when you press Enter; fix it, or Enter again to send (default)`,
    `/english feedback after        send at once, show the feedback afterwards`,
    `/english feedback off          no feedback on your English`,
    `/english demo                  show a sample feedback card`,
    `/en <text>                     turn Chinese or rough English into an English draft in the box`,
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

export const register: Register = on => {
  // The message last held for fixing: Enter on it again sends it as is.
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
    return { text: (await HELP($, changed)).split('\n')[0] ?? '' }
  })

  on('command.run', { command: 'en' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: 'Usage: /en <Chinese or rough English>' }
    const s = await loadSettings($)
    const t = await translate($, text, await currentLevel($, s))
    if (!t) return { text: 'Could not make an English draft just now. Try again.' }
    await update($, feedback, (): Feedback => ({ kind: 'translated', original: text, ...t }))
    $.clock.after(50, () => void $.prompt.fill({ text: t.english }))
    return { text: 'English draft is in the prompt box: edit it, then press Enter.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const s = await loadSettings($)
    if (!s.isOn) return composed
    const section = { id: 'english-coach:mode', text: systemSection(s, await currentLevel($, s)), scope: 'session' as const }
    return { sections: [...composed.sections, section] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !isPerson(e.origin)) return next(e)
    const s = await loadSettings($)
    if (!s.isOn) return next(e)

    if (e.text.startsWith(RAW_PREFIX)) return next({ ...e, text: e.text.slice(RAW_PREFIX.length).trimStart() })

    const level = await currentLevel($, s)

    if (s.chinese !== 'off' && hasChinese(e.text)) {
      const t = await translate($, e.text, level)
      if (!t) {
        $.ui.toast('English coach: translation failed, sent as typed.')
        return next(e)
      }
      await update($, feedback, (): Feedback => ({ kind: 'translated', original: e.text, ...t }))
      if (s.chinese === 'auto') return next({ ...e, text: t.english })
      $.clock.after(50, () => void $.prompt.fill({ text: t.english }))
      return { drop: `Not sent: your English draft is in the box. (Start with "${RAW_PREFIX}" to send Chinese as typed.)` }
    }

    if (s.checkWhen === 'off' || !isCheckable(e.text)) return next(e)

    const original = e.text
    const record = async (r: Awaited<ReturnType<typeof check>>, isHeld: boolean) => {
      if (r && wordCount(original) >= WORDS_TO_ESTIMATE) {
        await addEstimate($, r.cefr)
        await publishLevel($, s)
      }
      await update($, feedback, (shown): Feedback | null =>
        shown?.original !== original
          ? shown
          : r
            ? { kind: 'checked', original, isNatural: r.isNatural, better: r.better, tips: r.tips, upgrade: r.upgrade, isHeld }
            : null,
      )
    }

    if (s.checkWhen === 'after') {
      await update($, feedback, (): Feedback => ({ kind: 'pending', original }))
      // Off the dispatch, so the turn is not held up by the check.
      $.clock.after(0, async () => record(await check($, original, s, level), false))
      return next(e)
    }

    // Before sending: Enter on a held message again sends it as is.
    if (held !== null && original.trim() === held.trim()) {
      held = null
      await update($, feedback, (shown): Feedback | null =>
        shown?.kind === 'checked' && shown.isHeld ? { ...shown, isHeld: false } : shown,
      )
      return next(e)
    }

    await update($, feedback, (): Feedback => ({ kind: 'pending', original }))
    const r = await check($, original, s, level, HOLD_TIMEOUT_MS)
    const isHeld = r !== null && !r.isNatural && r.better !== '' && r.better.trim() !== original.trim()
    await record(r, isHeld)
    if (!isHeld) return next(e)

    held = original
    $.clock.after(50, () => void $.prompt.fill({ text: original }))
    return { drop: 'Not sent: see the card above the prompt.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const fb = await read($, feedback)
    if (e.props.hasSurvey || fb === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const hide = <Button key="hide" plain label="✕" onPress={() => update($, feedback, () => null)} />

    const card = (color: string, title: string, ...body: RenderChildren[]) => (
      <Box key="card" flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box justifyContent="space-between">
          <Text color={color} bold>
            {title}
          </Text>
          {hide}
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
        '中 → EN   Your English draft is in the box',
        <Box marginTop={1}>
          <Text>{fb.english}</Text>
        </Box>,
        fb.phrases.length > 0 && (
          <Box key="phrases" flexDirection="column" marginTop={1}>
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
        <Box marginTop={1}>
          <Text dimColor>Edit it, then press Enter to send.</Text>
        </Box>,
      )
    }

    const upgrade = fb.upgrade !== '' && (
      <Box key="upgrade" marginTop={fb.isNatural ? 1 : 0}>
        <Text>
          <Text color="magenta" bold>
            ↑{' '}
          </Text>
          {fb.upgrade}
        </Text>
      </Box>
    )

    if (fb.isNatural) {
      return card('green', '✓ Natural English', upgrade)
    }

    return card(
      'yellow',
      '✎ Almost there',
      <Box key="diff" marginTop={1}>
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
        <Box key="tips" flexDirection="column" marginTop={1}>
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
      fb.isHeld && (
        <Box key="actions" marginTop={1}>
          <Button key="use" hotkey="u" variant="primary" label="Use suggestion" onPress={() => void $.prompt.fill({ text: fb.better })} />
          <Text dimColor>   or fix it yourself · Enter on your own text sends it as is</Text>
        </Box>
      ),
    )
  })

  // Glosses are made once the turn's reply is whole, off the dispatch.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) $.clock.after(300, () => void glossNewBlocks($))
    return done
  })

  // Draws a reply with its glosses; the stored reply, which Claude reads, is unchanged.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    seen.delete(e.requestId)
    seen.set(e.requestId, e.props.text)
    if (seen.size > 200) seen.delete(seen.keys().next().value!)

    const s = await loadSettings($)
    const made = (await read($, replyGlosses))[e.requestId]
    if (!s.isOn || !s.gloss || !made || made.text !== e.props.text || made.glosses.length === 0) return next(e)
    return next({ ...e, props: { ...e.props, text: applyGlosses(e.props.text, made.glosses) } })
  })

  // The level slider, at the right of the footer under the prompt.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const v = await read($, levelView)
    if (!v?.isOn) return next(e)

    const { Text } = $.ui.resolve(e)
    const marks = SCALE.flatMap((c, i) => {
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
        {v.isMeasuring ? <Text dimColor>{` measuring ${v.samples}/${v.needed}`}</Text> : ''}
      </Text>
    )
  })
}
