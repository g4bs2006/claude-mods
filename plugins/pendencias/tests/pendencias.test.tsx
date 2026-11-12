import { expect, mock, test } from 'claude-code/testing'

type OnTeste = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

const PANE = {
  plugin: 'pendencias',
  component: 'Pane',
  requestId: 'pendencias',
  props: { title: 'Pendências', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'pendencias',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const fim = (texto: string) => ({ reason: 'answer' as const, answer: texto, durationMs: 1, isAborted: false, turnId: 't' })

function engine(on: OnTeste, sessao: string, guardadas: unknown[] = []) {
  const relogio = mock.clock(on, { now: 1_700_000_000_000 })
  const store = new Map<string, unknown>([['itens', guardadas]])
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'pendencias' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessao }))
  on('session.cwd', () => ({ value: '/home/g/PequiDev' }))
  on('session.repo', () => ({ value: { root: '/home/g/PequiDev', remote: null, internal: false, name: 'PequiDev' } }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '{"pendencias": ["Aprovar a aplicação da migração 0056 em produção"]}',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  return relogio
}

test('o pedido do fim da resposta vira pendência e some quando o turno seguinte não pede nada', async ($, on) => {
  const relogio = engine(on, 's1')
  await $.session.start({ cwd: '/home/g/PequiDev', surface: 'desktop', isInteractive: true })
  await $.turn.complete(fim('Migração 0056 pronta. Posso aplicar em produção?'))
  await relogio.settle()

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /migração 0056/ }))?.text).toBe('• Aprovar a aplicação da migração 0056 em produção')
    await ui.unmount()
  }

  await $.turn.complete(fim('Feito: a migração está aplicada e o app respondendo.'))
  await relogio.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nada esperando você.')
  await ui.unmount()
})

test('pendências de outra sessão aparecem na faixa e saem com Feito', async ($, on) => {
  const relogio = engine(on, 's2', [
    { id: 'a1', texto: 'Fazer merge do PR #388', projeto: 'outro-projeto', sessao: 's1', origem: 'auto', criadaEm: 1_699_990_000_000 },
  ])
  await $.session.start({ cwd: '/home/g/PequiDev', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text' }))?.text).toContain('1 pendência(s) de outras sessões · outro-projeto: Fazer merge do PR #388')
  await band.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /outra sessão/ }))?.text).toContain('há 3 h')
  await ui.press({ key: 'r-a1' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nada esperando você.')
  await ui.unmount()
  await relogio.settle()
})
