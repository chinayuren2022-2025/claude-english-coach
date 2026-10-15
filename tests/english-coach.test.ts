import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On, PromptComposeInput, RenderElement } from 'claude-code'

import { diffWords } from '../hooks/register'

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

const world = (on: On, store: Record<string, unknown> = {}) => {
  mock.store(on, store)
  const clock = mock.clock(on)
  const filled: string[] = []
  const sent: string[] = []
  const prompts: string[] = []
  const drawn: string[] = []
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Shall I add a retry?', toolUses: [] }] }) as never)
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
    if (e.system?.includes('read an English reply')) {
      return { value: { isAnswered: true, usage: USAGE as never, text: '{"glosses": [{"term": "idempotent", "zh": "幂等的"}]}' } }
    }
    const value: ModelCompleteResult = {
      isAnswered: true,
      usage: USAGE as never,
      text: e.system?.includes('turn a learner')
        ? '{"english": "Please help me fix this bug.", "phrases": [{"zh": "修复", "en": "fix"}]}'
        : e.prompt.includes('This sentence is fine')
          ? '{"natural": true, "better": "", "tips": [], "upgrade": "fine → spot on", "cefr": "B2"}'
          : '{"natural": false, "better": "Can you help me fix this bug?", "tips": ["help 后面直接接动词原形", "fix 前不用 to"], "upgrade": "fix this bug → track down this bug", "cefr": "B2"}',
    }
    return { value }
  })
  return { clock, filled, sent, prompts, drawn }
}

const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('adds the English-only section to the system prompt', async ($, on) => {
  world(on)
  const { sections } = await $.prompt.compose(COMPOSE)
  const mine = sections.find(s => s.id === 'english-coach:mode')
  expect(mine?.text).toContain('Write every reply in English')
  expect(mine?.text).toContain('B1')
  // Glosses are drawn afterwards, so the prompt asks Claude for none.
  expect(mine?.text).not.toContain('（')
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
    await ui.unmount()
  }
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

test('Chinese inside code does not trigger translation', async ($, on) => {
  const w = world(on, { settings: { checkWhen: 'off' } })
  await submit($, 'What does `console.log("你好")` print?')
  expect(w.sent).toEqual(['What does `console.log("你好")` print?'])
})

test('a message that needs fixing is held in the box with a suggestion', async ($, on) => {
  const w = world(on)
  const r = await submit($, 'Can you help me to fixing this bug')
  expect(r.drop).toContain('Not sent')
  expect(w.sent.length).toBe(0)
  await w.clock.advance(100)
  expect(w.filled).toEqual(['Can you help me to fixing this bug'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: ' to fixing' })).toBeDefined()
    expect(await ui.find({ text: ' fix' })).toBeDefined()
    expect(await ui.find({ text: 'fix 前不用 to' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'use' })
  expect(w.filled.at(-1)).toBe('Can you help me fix this bug?')
})

test('Enter again on the held message sends it as is', async ($, on) => {
  const w = world(on)
  await submit($, 'Can you help me to fixing this bug')
  await submit($, 'Can you help me to fixing this bug')
  expect(w.sent).toEqual(['Can you help me to fixing this bug'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'use' })).toBeUndefined()
})

test('a natural message is sent at once, with a step up shown', async ($, on) => {
  const w = world(on)
  await submit($, 'This sentence is fine as it is')
  expect(w.sent).toEqual(['This sentence is fine as it is'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /Natural English/ })).toBeDefined()
  expect(await ui.find({ text: 'fine → spot on' })).toBeDefined()
})

test('after mode sends at once and shows feedback later', async ($, on) => {
  const w = world(on, { settings: { checkWhen: 'after' } })
  await submit($, 'Can you help me to fixing this bug')
  expect(w.sent).toEqual(['Can you help me to fixing this bug'])
  await w.clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: ' to fixing' })).toBeDefined()
  expect(await ui.find({ key: 'use' })).toBeUndefined()
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
  expect((await $.prompt.compose(COMPOSE)).sections.at(-1)?.text).toContain('around CEFR B1, aiming for IELTS 7.5')
  for (let i = 0; i < 3; i++) {
    await submit($, `I have been trying to understand why this function returns the wrong value ${i}`)
    await w.clock.settle()
  }
  expect((await $.prompt.compose(COMPOSE)).sections.at(-1)?.text).toContain('around CEFR B2')
})

test('short messages do not count toward the level', async ($, on) => {
  const w = world(on)
  for (let i = 0; i < 3; i++) {
    await submit($, 'fix it please')
    await w.clock.settle()
  }
  expect((await $.prompt.compose(COMPOSE)).sections.at(-1)?.text).toContain('around CEFR B1')
})

test('a fixed level overrides the estimate', async ($, on) => {
  world(on, { settings: { level: 'C1' }, estimates: ['A2', 'A2', 'A2'] })
  expect((await $.prompt.compose(COMPOSE)).sections.at(-1)?.text).toContain('around CEFR C1')
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
    expect(await ui.find({ text: ' measuring 0/3' })).toBeDefined()
    await ui.unmount()
  }
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
  expect(await ui.find({ key: 'use' })).toBeDefined()
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
