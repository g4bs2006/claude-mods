import { expect, mock, test } from 'claude-code/testing'

type OnTeste = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

const PANE = {
  plugin: 'sol-delegacoes',
  component: 'Pane',
  requestId: 'sol',
  props: {
    title: 'Sol: delegações',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SAIDA = `gravado rascunho/engine.ts
gravado rascunho/objetos.ts

2 arquivo(s) em 84s · tokens: entrada 51234, saída 9876

Notas do Sol:
Balão do Pequi pronto; faltou o teste de toque.`

function engine(on: OnTeste, saida: string) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'sol' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__sol-delegacoes__sol_revisao' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/repo\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: '# Brincadeira 8: o balão\n\nEspecificação...' }))
  on('fs.exists', () => ({ value: false }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: saida, stderr: '', interrupted: false }, text: saida }))
  on('tool.call', { tool: 'mcp__sol-delegacoes__sol_revisao' }, () => ({ result: 'ok' }))
}

test('uma delegação entregue aparece esperando revisão', async ($, on) => {
  engine(on, SAIDA)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'node scripts/sol.mjs tarefa.md rascunho src/x.ts' })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /balão/ }))?.text).toBe('Brincadeira 8: o balão')
    expect((await ui.find({ type: 'Text', text: /esperando revisão/ }))?.text).toContain('2 arquivo(s) · 84s')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const botao = await ui.find({ type: 'Button', text: 'Com ajustes' })
  await ui.press({ key: botao!.key! })
  expect((await ui.find({ type: 'Text', text: /aceita com ajustes:/ }))?.text).toContain('Brincadeira 8')
  await ui.unmount()
})

test('a revisão marcada pelo Claude atualiza o painel', async ($, on) => {
  engine(on, SAIDA)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'node scripts/sol.mjs tarefa.md rascunho' })
  const r = await $.tool.call({
    tool: 'mcp__sol-delegacoes__sol_revisao',
    pasta: 'rascunho/',
    resultado: 'recusada',
    nota: 'engine.ts veio compactado',
  })
  expect(String(r.result)).toContain('recusada')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^recusada:/ }))?.text).toContain('Brincadeira 8')
  await ui.unmount()
})

test('uma delegação que falha fica marcada como falhou', async ($, on) => {
  engine(on, 'Defina OPENAI_API_KEY antes de rodar.')
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'node scripts/sol.mjs tarefa.md rascunho' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^falhou/ }))?.text).toBe('falhou')
  await ui.unmount()
})
