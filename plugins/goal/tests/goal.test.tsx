import { expect, mock, test } from 'claude-code/testing'

type OnTeste = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

const PANE = {
  plugin: 'goal',
  component: 'Pane',
  requestId: 'goal',
  props: {
    title: 'Goal',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

function engine(on: OnTeste) {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'meta' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__goal__goal_definir' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'repo' } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'Modo sonho, brincadeira 8: o balão\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({
    result: { task: { id: e.subject.includes('motor') ? '1' : '2', subject: e.subject } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))
  on('tool.call', { tool: 'mcp__goal__goal_definir' }, () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: 'ok' }))
}

test('as tasks viram etapas e o painel mostra o progresso', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__goal__goal_definir', goal: 'Entregar a brincadeira 8' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Balão no motor', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Painel do comentário', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.turn.complete({ reason: 'answer', answer: 'feito', durationMs: 1, isAborted: false, turnId: 't1' })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /brincadeira 8$/ }))?.text).toBe('Entregar a brincadeira 8')
    expect((await ui.find({ type: 'Text', text: /1\/2/ }))?.text).toContain('1/2 · 50%')
    expect((await ui.find({ type: 'Button', text: /Balão no motor/ }))?.text).toContain('✓')
    expect((await ui.find({ type: 'Text', text: /commit/ }))?.text).toContain('1 commit(s)')
    await ui.unmount()
  }

  // Tocar numa etapa pendente a marca como feita.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const etapa = await ui.find({ type: 'Button', text: /Painel do comentário/ })
  await ui.press({ key: etapa!.key! })
  expect((await ui.find({ type: 'Text', text: /2\/2/ }))?.text).toContain('100%')
  await ui.unmount()
})

test('o goal entra no prompt do sistema', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__goal__goal_definir', goal: 'Publicar o blog' })
  const r = await $.prompt.compose({
    model: 'x', promptModel: 'x', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [], sections: [],
  } as never)
  expect(r.sections.map(s => s.text).join('\n')).toContain('Publicar o blog')
})
