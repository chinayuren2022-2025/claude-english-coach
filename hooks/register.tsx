import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { Feedback, Phrase } from '../types'

const feedback = atom({ plugin: 'english-coach', key: 'feedback' } as const, null)

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

// How long a check before sending may hold a message up; past it, the message is sent.
const HOLD_TIMEOUT_MS = 10_000

// Prefix that sends a prompt as typed, Chinese included.
const RAW_PREFIX = 'zh:'

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

const levelLabel = async ($: EngineInterface, s: Settings) => {
  const level = await currentLevel($, s)
  if (s.level !== 'auto') return level
  const n = (await loadEstimates($)).length
  return n < ESTIMATES_NEEDED ? `${level}? (measuring)` : `~${level}`
}

const showStatus = async ($: EngineInterface, s: Settings) =>
  $.ui.status(s.isOn ? `EN ${await levelLabel($, s)} → ${s.goal}` : undefined)

const saveSettings = async ($: EngineInterface, s: Settings) => {
  await $.store.set('settings', s)
  await showStatus($, s)
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

const check = async ($: EngineInterface, text: string, s: Settings, level: Level, timeoutMs?: number) => {
  const json = await ask(
    $,
    `You coach a Chinese-speaking English learner, now around CEFR ${level}, whose goal is ${s.goal}. Judge the English of their message (ignore code, paths, commands). ` +
      `If it is clear and natural enough, set "natural" true; ignore casing, a missing final period and other tiny slips. ` +
      `Otherwise give the most natural version that keeps their meaning and words where possible, and one short tip in Simplified Chinese about the main mistake. ` +
      `Whether natural or not, offer one "upgrade": a more precise or higher-level word, collocation or structure that a ${s.goal} candidate would use for part of the message, written "plain → better" (empty if nothing fits). ` +
      `Also estimate the CEFR level (A1, A2, B1, B2, C1 or C2) this message shows. ` +
      `Reply with JSON only: {"natural": true|false, "better": "<improved message, or empty>", "tip": "<中文提示, or empty>", "upgrade": "<plain → better, or empty>", "cefr": "<level>"}`,
    text,
    timeoutMs,
  )
  if (!json || typeof json.natural !== 'boolean') return null
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return {
    isNatural: json.natural,
    better: str(json.better),
    tip: str(json.tip),
    upgrade: str(json.upgrade),
    cefr: str(json.cefr).toUpperCase(),
  }
}

const systemSection = (s: Settings, level: Level) =>
  [
    `# English learning mode`,
    `The person is a Chinese-speaking English learner, currently around CEFR ${level}, aiming for ${s.goal}. They are using this session to practise English with you.`,
    `- Write every reply in English only, even when they write in Chinese. Code, commands, identifiers, file paths, quoted text and the glosses below are the only exceptions.`,
    `- Pitch your English at ${level}: common words, short sentences, active voice, one idea per sentence. Keep technical content exact; simplify the language, not the substance.`,
    `- To stretch them toward ${s.goal}, use a few useful words, collocations and linking phrases from one level above ${level} in each reply, where they fit naturally.`,
    s.gloss
      ? `- The first time a reply uses a word or phrase likely above ${level} (rare words, idioms, phrasal verbs, technical terms whose meaning is not obvious), put a short Simplified Chinese gloss in full-width parentheses right after it: "idempotent（幂等的）", "work around（绕过）". At most 5 per reply, never the same word twice in this conversation, and never inside code blocks, inline code, commands or paths.`
      : '',
    `- Do not correct their English in your replies unless they ask; a separate tool gives them feedback. Answer what they mean.`,
  ]
    .filter(Boolean)
    .join('\n')

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
    `/en <text>                     turn Chinese or rough English into an English draft in the box`,
    `Start a prompt with "${RAW_PREFIX}" to send it as typed.`,
  ].join('\n')

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

export const register: Register = on => {
  // The message last held for fixing: Enter on it again sends it as is.
  let held: string | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'english',
      description: 'English coach: show or change its settings',
      argumentHint: '[on|off|level auto|goal IELTS 7.5|gloss on|chinese review|feedback on]',
    })
    await $.command.register({
      name: 'en',
      description: 'Turn Chinese or rough English into an English draft in the prompt box',
      argumentHint: '<text>',
    })
    await showStatus($, await loadSettings($))
    return next(e)
  })

  on('command.run', { command: 'english' }, async ($, e) => {
    const s = await loadSettings($)
    if (!e.args.trim()) return { text: await HELP($, s) }
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
      return { drop: `English draft is in the box: check it, then press Enter. (Start with "${RAW_PREFIX}" to send Chinese as typed.)` }
    }

    if (s.checkWhen === 'off' || !isCheckable(e.text)) return next(e)

    const original = e.text
    const record = async (r: Awaited<ReturnType<typeof check>>, isHeld: boolean) => {
      if (r && wordCount(original) >= WORDS_TO_ESTIMATE) {
        await addEstimate($, r.cefr)
        await showStatus($, s)
      }
      await update($, feedback, (shown): Feedback | null =>
        shown?.original !== original
          ? shown
          : r
            ? { kind: 'checked', original, isNatural: r.isNatural, better: r.better, tip: r.tip, upgrade: r.upgrade, isHeld }
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
    return { drop: 'Not sent yet: see the suggestion above the prompt. Fix your message, or press Enter to send it as is.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const fb = await read($, feedback)
    if (e.props.hasSurvey || fb === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const hide = <Button key="hide" plain label="✕" onPress={() => update($, feedback, () => null)} />

    if (fb.kind === 'pending') {
      return <Text dimColor>✎ Checking your English…</Text>
    }

    if (fb.kind === 'translated') {
      return (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan">中→EN </Text>
            <Text>{fb.english} </Text>
            {hide}
          </Box>
          {fb.phrases.length > 0 && (
            <Text dimColor>{fb.phrases.map(p => `${p.zh} → ${p.en}`).join('   ')}</Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {fb.isNatural ? (
          <Box>
            <Text color="green">✓ Natural English. </Text>
            {hide}
          </Box>
        ) : (
          <Box>
            <Text color="yellow">✎ Better: </Text>
            <Text>{fb.better} </Text>
            {hide}
          </Box>
        )}
        {!fb.isNatural && fb.tip !== '' && <Text dimColor>  {fb.tip}</Text>}
        {fb.isHeld && (
          <Box>
            <Button key="use" hotkey="u" label="Use suggestion" onPress={() => void $.prompt.fill({ text: fb.better })} />
            <Text dimColor> or fix it yourself · Enter on your own text sends it as is</Text>
          </Box>
        )}
        {fb.upgrade !== '' && (
          <Box>
            <Text color="magenta">↑ Level up: </Text>
            <Text>{fb.upgrade}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
