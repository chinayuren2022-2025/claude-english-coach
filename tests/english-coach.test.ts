import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On, PromptComposeInput, PromptEditInput, RenderElement } from 'claude-code'

import { applyFixes, diffWords, paragraphs, repliesOf } from '../hooks/register'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const COMPOSE: PromptComposeInput = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
}

const BAND = {
  plugin: 'english-coach',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const SLIDER = { plugin: 'english-coach', component: 'SessionMode', props: { modes: [] } } as const

const POINTS = { did: '读了 cache.ts，找到两次写入', point: '两个请求同时到达时缓存会被写两次', ask: '要不要现在加锁？' }

const world = (on: On, store: Record<string, unknown> = {}, messages: unknown[] = [{ role: 'assistant', text: 'Shall I add a retry?', toolUses: [] }]) => {
  mock.store(on, store)
  const clock = mock.clock(on)
  const filled: string[] = []
  const sent: string[] = []
  const prompts: string[] = []
  const drawn: string[] = []
  on('session.messages', () => ({ value: messages }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    drawn.push(e.props.text)
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'reply' }) as RenderElement
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  // Stands for the engine's empty band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as RenderElement
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    if (e.system?.includes('into natural Simplified Chinese')) {
      const para = e.prompt.split('Translate this paragraph:\n"""\n')[1]?.replace(/\n"""$/, '') ?? ''
      if (para.includes('FAIL')) return { value: { isAnswered: false, reason: 'api-error', status: 500 } as never }
      return { value: { isAnswered: true, usage: USAGE as never, text: `译：${para}` } }
    }
    if (e.system?.includes("the reply's key points")) {
      const points = e.prompt.includes('Shall I') ? POINTS : { ...POINTS, ask: '' }
      return { value: { isAnswered: true, usage: USAGE as never, text: JSON.stringify(points) } }
    }
    if (e.system?.includes('read an English reply')) {
      return { value: { isAnswered: true, usage: USAGE as never, text: '{"glosses": [{"term": "idempotent", "zh": "幂等的"}]}' } }
    }
    const value: ModelCompleteResult = {
      isAnswered: true,
      usage: USAGE as never,
      text: e.system?.includes('turn a learner')
        ? '{"english": "Please help me fix this bug.", "phrases": [{"zh": "修复", "en": "fix"}]}'
        : e.prompt.includes('This sentence is fine')
          ? '{"errors": [{"wrong": "is fine", "right": "is fine", "type": "grammar", "tip": "不用改"}], "upgrade": "fine → spot on", "cefr": "B2"}'
          : JSON.stringify({
              errors: [
                { wrong: 'help me to fixing', right: 'help me fix', type: 'grammar', tip: 'fix 前不用 to' },
                { wrong: 'Can you', right: 'Could you', type: 'style', tip: '更礼貌' },
              ],
              upgrade: 'fix this bug → track down this bug',
              cefr: 'B2',
            }),
    }
    return { value }
  })
  return { clock, filled, sent, prompts, drawn }
}

// The level as /english reports it.
const levelOf = async ($: Engine) => {
  const r = (await $.command.run({ command: 'english', args: '', origin: { kind: 'composer' } } as never)) as { text: string }
  return r.text.split(' · ')[1] ?? ''
}

// The test engine runs prompt.edit, though its type does not list the call.
type Edit = { edit: (input: PromptEditInput) => Promise<{ text: string; cursor: number }> }
// Types one character at the end of the box; a Chinese input method's "·" comes with no key.
const type = ($: Engine, text: string, typed = '`') =>
  ($.prompt as unknown as Edit).edit({
    origin: { kind: 'composer' },
    ...(typed === '`' ? { key: { key: '`' } } : {}),
    text,
    cursor: text.length,
    start: text.length,
    end: text.length,
    inputText: typed,
  })

const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('the system prompt asks for English and nothing else', async ($, on) => {
  world(on)
  const { sections } = await $.prompt.compose(COMPOSE)
  const mine = sections.find(s => s.id === 'english-coach:mode')
  expect(mine?.text).toContain('Write every reply in English')
  // Feedback and glosses happen after the reply, so Claude is told nothing about them.
  for (const word of ['learner', 'translation', 'gloss', 'feedback', 'B1', 'IELTS']) expect(mine?.text).not.toContain(word)
})

test('leaves the system prompt alone when switched off', async ($, on) => {
  world(on, { settings: { isOn: false } })
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.some(s => s.id === 'english-coach:mode')).toBe(false)
})

test('Chinese input becomes an English draft in the box, with key phrases above it', async ($, on) => {
  const w = world(on)
  const r = await submit($, '帮我修复这个bug')
  expect(r.drop).toContain('English draft')
  expect(w.sent.length).toBe(0)
  await w.clock.advance(100)
  expect(w.filled).toEqual(['Please help me fix this bug.'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /修复 → fix/ })).toBeDefined()
    expect(await ui.find({ text: /back to your Chinese/ })).toBeDefined()
    await ui.unmount()
  }
  // The card waits with the draft: its button is there until something is sent.
  await w.clock.advance(30_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /修复 → fix/ })).toBeDefined()
})

const ZH = '帮我修复这个bug'
const DRAFT = 'Please help me fix this bug.'

test('the card\'s button swaps an English draft and the Chinese, on every surface', async ($, on) => {
  const w = world(on)
  await submit($, ZH)
  await w.clock.advance(100)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'swap' })
    expect(w.filled.at(-1)).toBe(ZH)
    expect(await ui.find({ text: /Your Chinese is back/ })).toBeDefined()
    await ui.press({ key: 'swap' })
    expect(w.filled.at(-1)).toBe(DRAFT)
    expect(await ui.find({ text: /back to your Chinese/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Enter on the Chinese brought back sends it as typed; edited, it becomes a new draft', async ($, on) => {
  const w = world(on)
  await submit($, ZH)
  await $.ui.mount({ ...BAND, surface: 'terminal' }).then(ui => ui.press({ key: 'swap' }))
  const r = await submit($, ZH)
  expect(r.drop).toBeUndefined()
  expect(w.sent).toEqual([ZH])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /Your Chinese is back|back to your Chinese/ })).toBeUndefined()

  await submit($, ZH)
  await ui.press({ key: 'swap' })
  const edited = await submit($, `${ZH}，谢谢`)
  expect(edited.drop).toContain('English draft')
  expect(w.sent).toEqual([ZH])
})

test('an untouched English draft is sent without a check', async ($, on) => {
  const w = world(on)
  await submit($, ZH)
  const asked = w.prompts.length
  await submit($, DRAFT)
  expect(w.sent).toEqual([DRAFT])
  expect(w.prompts.length).toBe(asked)
})

test('the swap key takes an English draft back to the Chinese; in the Chinese it types as usual', async ($, on) => {
  world(on)
  on('prompt.edit', ($, e) => ({ text: e.text + e.inputText, cursor: e.cursor + e.inputText.length }))
  await submit($, ZH)
  expect((await type($, DRAFT, '·')).text).toBe(ZH)
  expect((await type($, ZH, '、')).text).toBe(`${ZH}、`)
  expect((await type($, ZH, '`')).text).toBe(`${ZH}\``)
})

test('auto mode sends the translation at once', async ($, on) => {
  const w = world(on, { settings: { chinese: 'auto' } })
  await submit($, '帮我修复这个bug')
  expect(w.sent).toEqual(['Please help me fix this bug.'])
})

test('the zh: prefix sends Chinese as typed', async ($, on) => {
  const w = world(on)
  await submit($, 'zh: 这段报错是什么意思')
  expect(w.sent).toEqual(['这段报错是什么意思'])
})

test('Chinese in file references and quotes does not make a message Chinese', async ($, on) => {
  const w = world(on, { settings: { checkWhen: 'off' } })
  const messages = [
    'Please summarize @笔记.md for me',
    'Read @"Academic/02 扭摆 实验/report.pdf" and list the results',
    'Open /Users/me/Academic/02 扭摆 实验/report.pdf and check the units',
    'Rename 扭摆实验报告.pdf to report.pdf',
    'Look at C:\\Users\\me\\文档\\plan.docx please',
    'Change the button text to “用户登录” on the login page',
  ]
  for (const text of messages) {
    const r = await submit($, text)
    expect(r.drop).toBeUndefined()
  }
  expect(w.sent).toEqual(messages)
  expect(w.filled).toEqual([])
})

test('Chinese prose beside a file reference still becomes a draft', async ($, on) => {
  const w = world(on)
  const r = await submit($, 'Read 扭摆实验报告.pdf 然后帮我总结一下')
  expect(r.drop).toContain('English draft')
  expect(w.sent).toEqual([])
})

test('Chinese inside code does not trigger translation', async ($, on) => {
  const w = world(on, { settings: { checkWhen: 'off' } })
  await submit($, 'What does `console.log("你好")` print?')
  expect(w.sent).toEqual(['What does `console.log("你好")` print?'])
})

const MINE = 'Can you help me to fixing this bug'
const FIXED = 'Can you help me fix this bug'

test('a message that needs fixing is held, with the fix put in the box', async ($, on) => {
  const w = world(on)
  const r = await submit($, MINE)
  expect(r.drop).toContain('corrected message is in the box')
  expect(w.sent.length).toBe(0)
  await w.clock.advance(100)
  expect(w.filled).toEqual([FIXED])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /Fixed in the box/ })).toBeDefined()
    expect(await ui.find({ text: ' to fixing' })).toBeDefined()
    expect(await ui.find({ text: ' fix' })).toBeDefined()
    expect(await ui.find({ text: 'fix 前不用 to' })).toBeDefined()
    expect(await ui.find({ text: /Enter send it · ` back to yours/ })).toBeDefined()
    // Style ideas are not fixes.
    expect(await ui.find({ text: /Could/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('Enter on the fix sends it without a second check, and the card hides later', async ($, on) => {
  const w = world(on)
  await submit($, MINE)
  const checks = w.prompts.length
  await submit($, FIXED)
  expect(w.sent).toEqual([FIXED])
  expect(w.prompts.length).toBe(checks)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /Enter send/ })).toBeUndefined()
  expect(await ui.find({ text: /Almost there/ })).toBeDefined()
  await w.clock.advance(9000)
  expect(await ui.find({ text: /Almost there/ })).toBeUndefined()
})

test('backtick swaps the box between the fix and the person\'s own, and Enter sends either as it is', async ($, on) => {
  const w = world(on)
  on('prompt.edit', ($, e) => ({ text: e.text + e.inputText, cursor: e.cursor + e.inputText.length }))
  await submit($, MINE)
  expect((await type($, FIXED)).text).toBe(MINE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /` use the fix · Enter send yours as is/ })).toBeDefined()
  expect((await type($, MINE)).text).toBe(FIXED)
  expect((await type($, FIXED)).text).toBe(MINE)
  const checks = w.prompts.length
  await submit($, MINE)
  expect(w.sent).toEqual([MINE])
  expect(w.prompts.length).toBe(checks)
})

test('the card\'s button swaps a held fix too, and Enter sends the one in the box as it is', async ($, on) => {
  const w = world(on)
  await submit($, MINE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'swap' })
  expect(w.filled.at(-1)).toBe(MINE)
  expect(await ui.find({ text: /Almost there/ })).toBeDefined()
  await ui.press({ key: 'swap' })
  expect(w.filled.at(-1)).toBe(FIXED)
  expect(await ui.find({ text: /Fixed in the box/ })).toBeDefined()
  await ui.press({ key: 'swap' })
  const checks = w.prompts.length
  await submit($, MINE)
  expect(w.sent).toEqual([MINE])
  expect(w.prompts.length).toBe(checks)
})

test('what a Chinese input method types for that key swaps too: ·, 、 and ｀', async ($, on) => {
  world(on)
  on('prompt.edit', ($, e) => ({ text: e.text + e.inputText, cursor: e.cursor + e.inputText.length }))
  await submit($, MINE)
  expect((await type($, FIXED, '·')).text).toBe(MINE)
  expect((await type($, MINE, '、')).text).toBe(FIXED)
  expect((await type($, FIXED, '｀')).text).toBe(MINE)
})

test('、 types as usual in Chinese text, with nothing held', async ($, on) => {
  world(on)
  on('prompt.edit', ($, e) => ({ text: e.text + e.inputText, cursor: e.cursor + e.inputText.length }))
  expect((await type($, '函数', '、')).text).toBe('函数、')
})

test('backtick types as usual in an edited box, or with nothing held', async ($, on) => {
  const w = world(on)
  on('prompt.edit', ($, e) => ({ text: e.text + e.inputText, cursor: e.cursor + e.inputText.length }))
  expect((await type($, 'Run ')).text).toBe('Run `')
  await submit($, MINE)
  expect((await type($, 'Can you help me fixing this bug')).text).toBe('Can you help me fixing this bug`')
  // An edited message is checked again.
  const checks = w.prompts.length
  await submit($, 'Can you help me to fixing this bug now')
  expect(w.prompts.length).toBe(checks + 1)
})

test('a natural message is sent at once, with a step up shown', async ($, on) => {
  const w = world(on)
  await submit($, 'This sentence is fine as it is')
  expect(w.sent).toEqual(['This sentence is fine as it is'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /Natural English/ })).toBeDefined()
  expect(await ui.find({ text: 'fine → spot on' })).toBeDefined()
  await w.clock.advance(9000)
  expect(await ui.find({ text: /Natural English/ })).toBeUndefined()
})

test('a message with an image is sent at once and checked afterwards', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({
    text: '[Image #1] Can you help me to fixing this bug',
    wait: false,
    origin: { kind: 'composer' },
    attachments: [{ type: 'image', mediaType: 'image/png' }],
  })
  expect(w.sent).toEqual(['[Image #1] Can you help me to fixing this bug'])
  await w.clock.advance(100)
  expect(w.prompts.at(-1)).not.toContain('[Image #1]')
})

test('after mode sends at once and shows feedback later', async ($, on) => {
  const w = world(on, { settings: { checkWhen: 'after' } })
  await submit($, 'Can you help me to fixing this bug')
  expect(w.sent).toEqual(['Can you help me to fixing this bug'])
  await w.clock.advance(100)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: ' to fixing' })).toBeDefined()
  expect(await ui.find({ text: /Enter send|use the fix/ })).toBeUndefined()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ text: /Almost there/ })).toBeUndefined()
})

test('the band offers a step up toward the goal', async ($, on) => {
  const w = world(on)
  await submit($, 'Can you help me to fixing this bug')
  await w.clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: 'fix this bug → track down this bug' })).toBeDefined()
})

test('auto level starts at B1 and follows what the person writes', async ($, on) => {
  const w = world(on)
  expect(await levelOf($)).toBe('level B1? (measuring)')
  for (let i = 0; i < 3; i++) {
    await submit($, `I have been trying to understand why this function returns the wrong value ${i}`)
    await w.clock.settle()
  }
  expect(await levelOf($)).toBe('level ~B2')
})

test('short messages do not count toward the level', async ($, on) => {
  const w = world(on)
  for (let i = 0; i < 3; i++) {
    await submit($, 'fix it please')
    await w.clock.settle()
  }
  expect(await levelOf($)).toBe('level B1? (measuring)')
})

test('a fixed level overrides the estimate', async ($, on) => {
  world(on, { settings: { level: 'C1' }, estimates: ['A2', 'A2', 'A2'] })
  expect(await levelOf($)).toBe('level C1')
})

test('the slider under the prompt shows the level and the goal', async ($, on) => {
  const w = world(on)
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...SLIDER, surface })
    expect(await ui.find({ text: ' B1? ' })).toBeDefined()
    expect(await ui.find({ text: 'C1★' })).toBeDefined()
    await ui.unmount()
  }
  const terminal = await $.ui.mount({ ...SLIDER, surface: 'terminal' })
  expect(await terminal.find({ text: 'A1' })).toBeDefined()
  expect(await terminal.find({ text: ' measuring 0/3' })).toBeDefined()
  await terminal.unmount()
  // The desktop cuts the label short, so it draws only B1?─B2─C1★.
  const desktop = await $.ui.mount({ ...SLIDER, surface: 'desktop' })
  expect(await desktop.find({ text: 'B2' })).toBeDefined()
  for (const text of ['A1', 'A2', 'C2', /measuring/]) expect(await desktop.find({ text })).toBeUndefined()
  await desktop.unmount()
  for (let i = 0; i < 3; i++) {
    await submit($, `I have been trying to understand why this function returns the wrong value ${i}`)
    await w.clock.settle()
  }
  const ui = await $.ui.mount({ ...SLIDER, surface: 'terminal' })
  expect(await ui.find({ text: ' B2 ' })).toBeDefined()
  expect(await ui.find({ text: /measuring/ })).toBeUndefined()
})

test('/english demo shows a sample card', async ($, on) => {
  world(on)
  await $.command.run({ command: 'english', args: 'demo', origin: { kind: 'composer' } } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /Almost there/ })).toBeDefined()
  expect(await ui.find({ text: /use the fix/ })).toBeDefined()
})

const REPLY = 'Make the handler idempotent so a retry is safe.\n\n```js\nconst idempotent = true\n```'

test('glosses are added to the drawn reply after the turn, outside code', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({
    plugin: 'english-coach',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: REPLY, isFirstOfReply: true },
  })
  expect(w.drawn.at(-1)).toBe(REPLY)
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
  await w.clock.advance(400)
  const glossed = 'Make the handler idempotent（幂等的） so a retry is safe.\n\n```js\nconst idempotent = true\n```'
  expect(w.drawn.at(-1)).toBe(glossed)
  await ui.unmount()
})

test('no glosses when they are switched off', async ($, on) => {
  const w = world(on, { settings: { gloss: false } })
  await $.ui.mount({ plugin: 'english-coach', surface: 'terminal', component: 'AssistantMessage', props: { text: REPLY, isFirstOfReply: true } })
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
  await w.clock.advance(400)
  expect(w.drawn.at(-1)).toBe(REPLY)
})

const CODE = '```ts\nconst lock = new Mutex()\n\nawait lock.run(fill)\n```'
const LAST = `There is a race condition in the cache.\n\nAdd a lock:\n\n${CODE}\n\nThen run the tests again.`
const CONVO = [
  { role: 'user', text: 'Why does the test fail?', toolUses: [] },
  { role: 'assistant', text: 'The first reply.', toolUses: [] },
  { role: 'user', text: 'And now?', toolUses: [] },
  { role: 'assistant', text: 'Let me look.', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'FAIL cache.test.ts', isError: false }] },
  { role: 'assistant', text: LAST, toolUses: [] },
]

const zh = ($: Engine, args = '') => $.command.run({ command: 'zh', args, origin: { kind: 'composer' } } as never) as Promise<{ text?: string; context?: string[] }>

const reply = (text: string) =>
  ({ plugin: 'english-coach', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } }) as const

const chinese = async (ui: { find: (q: { key: string }) => Promise<{ text?: string } | undefined> }) => (await ui.find({ key: 'zh-text' }))?.text

test('a reply\'s paragraphs: a code block with blank lines in it is one', () => {
  expect(paragraphs(LAST)).toEqual(['There is a race condition in the cache.', 'Add a lock:', CODE, 'Then run the tests again.'])
})

test('Claude\'s replies are what it wrote after each prompt, tool output left out', () => {
  expect(repliesOf(CONVO as never)).toEqual(['The first reply.', `Let me look.\n\n${LAST}`])
})

test('/zh draws the last reply in Chinese under it, paragraph by paragraph, code kept, and prints nothing', async ($, on) => {
  const w = world(on, {}, CONVO)
  const ui = await $.ui.mount(reply(LAST))
  expect(await chinese(ui)).toBeUndefined()
  const r = await zh($)
  // Nothing for the transcript, which Claude reads: the Chinese is only drawn.
  expect(r.text).toBeUndefined()
  expect(r.context).toBeUndefined()
  await w.clock.settle()
  expect(await chinese(ui)).toBe(
    '译：There is a race condition in the cache.\n\n译：Add a lock:\n\n〔代码见上〕\n\n译：Then run the tests again.',
  )
  // The English Claude wrote is drawn as it was.
  expect(w.drawn.at(-1)).toBe(LAST)
  // The block before, in the same reply, gets its own paragraph.
  const before = await $.ui.mount(reply('Let me look.'))
  expect(await chinese(before)).toBe('译：Let me look.')
  // Each paragraph is translated with the one before it as context.
  expect(w.prompts.find(p => p.includes('Translate this paragraph:\n"""\nAdd a lock:'))).toContain('race condition in the cache')
})

test('/zh again hides the Chinese, and shows it once more without asking Haiku again', async ($, on) => {
  const w = world(on, {}, CONVO)
  const ui = await $.ui.mount(reply(LAST))
  await zh($)
  await w.clock.settle()
  const asked = w.prompts.length
  await zh($)
  expect(await chinese(ui)).toBeUndefined()
  await zh($)
  await w.clock.settle()
  expect(await chinese(ui)).toContain('译：Add a lock:')
  expect(w.prompts.length).toBe(asked)
})

test('/zh 2 translates the reply before the last; the last stays in English', async ($, on) => {
  const w = world(on, {}, CONVO)
  const first = await $.ui.mount(reply('The first reply.'))
  const last = await $.ui.mount(reply(LAST))
  await zh($, '2')
  await w.clock.settle()
  expect(await chinese(first)).toBe('译：The first reply.')
  expect(await chinese(last)).toBeUndefined()
})

test('a paragraph that failed says so, and /zh tries it again', async ($, on) => {
  const failing = 'FAIL this paragraph.'
  const w = world(on, {}, [{ role: 'user', text: 'Go', toolUses: [] }, { role: 'assistant', text: `Fine here.\n\n${failing}`, toolUses: [] }])
  const ui = await $.ui.mount(reply(`Fine here.\n\n${failing}`))
  await zh($)
  await w.clock.settle()
  expect(await chinese(ui)).toBe('译：Fine here.\n\n（这一段没翻译成功，再输入 /zh 重试）')
  const asked = w.prompts.length
  await zh($)
  await w.clock.settle()
  // Only the failed paragraph is asked for again, and the Chinese stays shown.
  expect(w.prompts.length).toBe(asked + 1)
  expect(await chinese(ui)).toContain('译：Fine here.')
})

test('/zh with no reply yet, or a bad argument, says so', async ($, on) => {
  world(on, {}, [])
  expect((await zh($)).text).toContain('No reply')
  expect((await zh($, 'x')).text).toContain('Usage')
})

// A reply of just over 150 English words, the code in it not counted.
const LONG = `${'When two requests arrive together, the cache is filled twice and the second write wins. '.repeat(10)}\n\n${CODE}\n\nShall I add the lock now?`
const LONG_CONVO = [
  { role: 'user', text: 'Why is the cache wrong?', toolUses: [] },
  { role: 'assistant', text: 'Let me look.', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'cache.ts', isError: false }] },
  { role: 'assistant', text: LONG, toolUses: [] },
]

const endTurn = ($: Engine, extra = {}) =>
  $.turn.complete({ answer: LONG, durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn', ...extra } as never)

const pointsAsked = (prompts: string[]) => prompts.filter(p => p.startsWith('The reply:')).length

// find() gives the drawn tree that has the text; this is the element in it that holds the text itself.
type Drawn = { props?: Record<string, unknown>; children?: (Drawn | string)[] }
const holding = (node: unknown, text: string): Drawn | undefined => {
  const n = node as Drawn | undefined
  if (n?.children?.includes(text)) return n
  for (const c of n?.children ?? []) {
    const found = typeof c === 'string' ? undefined : holding(c, text)
    if (found) return found
  }
  return undefined
}

test('a long reply gets its key points in Chinese under its last block, the question marked', async ($, on) => {
  const w = world(on, {}, LONG_CONVO)
  const last = await $.ui.mount(reply(LONG))
  const before = await $.ui.mount(reply('Let me look.'))
  await endTurn($)
  await w.clock.advance(400)
  expect(await last.find({ text: /要点/ })).toBeDefined()
  expect(await last.find({ text: POINTS.did })).toBeDefined()
  expect(await last.find({ text: POINTS.point })).toBeDefined()
  const drawn = await last.find({ text: /问你/ })
  expect(holding(drawn, '问你  ')?.props).toMatchObject({ color: 'yellow', bold: true })
  expect(holding(drawn, POINTS.ask)?.props).toMatchObject({ color: 'yellow', bold: true })
  expect(holding(drawn, POINTS.point)?.props?.color).toBeUndefined()
  // Only the block that ends the reply has them, and Claude's English is drawn as it was.
  expect(await before.find({ text: /要点/ })).toBeUndefined()
  expect(new Set(w.drawn)).toEqual(new Set([LONG, 'Let me look.']))
  // Haiku reads the whole reply, once, however often the reply is drawn or the turn ends.
  expect(w.prompts.find(p => p.startsWith('The reply:'))).toContain('Let me look.')
  await endTurn($)
  await w.clock.advance(400)
  expect(pointsAsked(w.prompts)).toBe(1)
})

test('no question in the reply, no 问你 line', async ($, on) => {
  const text = LONG.replace('Shall I add the lock now?', 'The lock is in place now.')
  const w = world(on, {}, [{ role: 'user', text: 'Fix it', toolUses: [] }, { role: 'assistant', text, toolUses: [] }])
  const ui = await $.ui.mount(reply(text))
  await endTurn($)
  await w.clock.advance(400)
  expect(await ui.find({ text: POINTS.point })).toBeDefined()
  expect(await ui.find({ text: /问你/ })).toBeUndefined()
})

test('a short reply gets no key points', async ($, on) => {
  const w = world(on, {}, CONVO)
  const ui = await $.ui.mount(reply(LAST))
  await endTurn($)
  await w.clock.advance(400)
  expect(await ui.find({ text: /要点/ })).toBeUndefined()
  expect(pointsAsked(w.prompts)).toBe(0)
})

test('an interrupted reply gets no key points', async ($, on) => {
  const w = world(on, {}, LONG_CONVO)
  await endTurn($, { isAborted: true })
  await w.clock.advance(400)
  expect(pointsAsked(w.prompts)).toBe(0)
})

test('/english points off: none made, and those made are hidden', async ($, on) => {
  const w = world(on, {}, LONG_CONVO)
  const ui = await $.ui.mount(reply(LONG))
  await endTurn($)
  await w.clock.advance(400)
  const r = (await $.command.run({ command: 'english', args: 'points off', origin: { kind: 'composer' } } as never)) as { text: string }
  expect(r.text).toContain('key points off')
  expect(await ui.find({ text: /要点/ })).toBeUndefined()
})

test('while /zh shows the reply in Chinese, its key points give way', async ($, on) => {
  const w = world(on, {}, LONG_CONVO)
  const ui = await $.ui.mount(reply(LONG))
  await endTurn($)
  await w.clock.advance(400)
  await zh($)
  await w.clock.settle()
  expect(await chinese(ui)).toContain('译：Shall I add the lock now?')
  expect(await ui.find({ text: /要点/ })).toBeUndefined()
  await zh($)
  expect(await ui.find({ text: POINTS.point })).toBeDefined()
})

test('the check reads Claude\'s last reply as context', async ($, on) => {
  const w = world(on)
  await submit($, 'Yes please, can you add it')
  expect(w.prompts.at(-1)).toContain('Shall I add a retry?')
  expect(w.prompts.at(-1)).toContain('Yes please, can you add it')
})

test('a changed run is drawn whole: struck words, then their replacement', () => {
  const pieces = diffWords(
    'Okay, quite good job. The next thing is: how do you deal with the reply of Claude Code?',
    'Good job, thanks. Next, how do you handle the reply from Claude Code?',
  )
  for (let k = 0; k + 1 < pieces.length; k++) {
    expect(`${pieces[k]?.kind}>${pieces[k + 1]?.kind}`).not.toBe('add>del')
    if (pieces[k]?.kind === 'del' && pieces[k + 1]?.kind === 'add') expect(pieces[k + 1]?.text.startsWith(' ')).toBe(true)
  }
  expect(pieces.filter(p => p.kind === 'same').map(p => p.text).join('')).toContain('how do you')
})

test('only real, exactly quoted fixes are applied', () => {
  const text = 'Please make the change after you read it, i think it works'
  const r = applyFixes(text, [
    { wrong: 'you read', right: 'I read', type: 'grammar', tip: '主语错' },
    { wrong: 'make the change', right: 'make changes', type: 'style', tip: '' },
    { wrong: 'not in the text', right: 'x', type: 'grammar', tip: '' },
    { wrong: 'i think', right: 'I think', type: 'grammar', tip: '大写' },
    { wrong: 'it works', right: 'it work', type: 'grammar', tip: '三单' },
  ])
  expect(r.fixes.map(f => f.tip)).toEqual(['三单'])
  expect(r.better).toBe('Please make the change after you read it, i think it work')
})

test('a missing apostrophe is a spelling fix, a curly one is not', () => {
  // Haiku's own answer to a message that was let through as natural.
  const r = applyFixes('Hi, just to test the plugin and you dont need to answer', [
    { wrong: 'dont', right: "don't", type: 'spelling', tip: "否定缩写 don't 需要撇号" },
  ])
  expect(r.better).toBe("Hi, just to test the plugin and you don't need to answer")
  expect(applyFixes("I don't know", [{ wrong: "don't", right: 'don’t', type: 'spelling', tip: '' }]).fixes).toEqual([])
})
