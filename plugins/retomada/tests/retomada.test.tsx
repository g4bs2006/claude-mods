import { expect, mock, test } from 'claude-code/testing'

type OnTeste = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

const PANE = {
  plugin: 'retomada',
  component: 'Pane',
  requestId: 'retomada',
  props: { title: 'Onde parou', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const BAND = {
  plugin: 'retomada',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const HORA = 60 * 60 * 1000

function engine(on: OnTeste) {
  const relogio = mock.clock(on, { now: 1_700_000_000_000 })
  const store = new Map<string, unknown>([
    ['ultimo:/repo', { resposta: 'Brincadeira 7 parte 1 no ar. Próximo passo: o painel do comentário, esperando a migração 0012.', quando: 1_700_000_000_000 - 26 * HORA, branch: 'pequi-comenta' }],
  ])
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'retomada' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'PequiDev' } }))
  on('prompt.submit', () => ({ text: '' }) as never)
  on('turn.complete', () => ({ text: 'ok' }))
  on('process.run', (_, e) => {
    const a = (e as { argv: string[] }).argv.slice(1).join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a.startsWith('rev-parse')) return out('main\n')
    if (a.startsWith('log -5')) return out('0207d4a\x1fDocs: estado da brincadeira 7\x1f3 hours ago\nc284eb5\x1fModo sonho, brincadeira 7 (parte 1)\x1f5 hours ago\n')
    if (a.startsWith('status')) return out(' M src/engine.ts\n?? docs/novo.md\n')
    if (a.startsWith('rev-list')) return out('0\t1\n')
    if (a.startsWith('log -1')) return out('3 hours ago\n\ndocs/modo-sonho.md\n')
    return out('', 1)
  })
  return { relogio, store }
}

test('a faixa e o painel mostram onde parou, e o Claude recebe o mesmo', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const linha = async (re: RegExp) => (await band.find({ type: 'Text', text: re }))?.text
  expect(await linha(/^Onde parou ·/)).toBe('Onde parou · main · 2 não commitado(s) · 1 commit(s) sem push')
  expect(await linha(/^Último commit/)).toBe('Último commit: Docs: estado da brincadeira 7 (3 hours ago)')
  expect(await linha(/^Fim da última/)).toContain('há 26 h')
  expect(await linha(/^Fim da última/)).toContain('esperando a migração 0012.')
  await band.unmount()

  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Doc mais recente/ }))?.text).toBe('Doc mais recente: docs/modo-sonho.md (3 hours ago)')
    await ui.unmount()
  }

  const r = await $.prompt.compose({ model: 'x', promptModel: 'x', surfaces: [], tools: [], outputStyle: null, traits: [], sections: [] } as never)
  const texto = r.sections.map(s => s.text).join('\n')
  expect(texto).toContain('c284eb5 Modo sonho, brincadeira 7 (parte 1)')
  expect(texto).toContain('Próximo passo: o painel do comentário')
})

test('o fim da resposta fica guardado para a próxima sessão', async ($, on) => {
  const { store } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ reason: 'answer', answer: 'Pronto. Falta você aprovar o PR.', durationMs: 1, isAborted: false, turnId: 't' })
  expect((store.get('ultimo:/repo') as { resposta: string; branch: string })).toMatchObject({ resposta: 'Pronto. Falta você aprovar o PR.', branch: 'main' })
})
