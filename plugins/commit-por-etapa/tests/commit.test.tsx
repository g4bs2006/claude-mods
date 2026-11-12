import { expect, mock, test } from 'claude-code/testing'

type OnTeste = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

const BAND = {
  plugin: 'commit-por-etapa',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

type Repo = { branch: string; arquivos: string[]; chamadas: string[][]; limpo: boolean }

function engine(on: OnTeste, repo: Repo) {
  const relogio = mock.clock(on)
  on('command.register', () => ({ value: { command: 'commit-etapa' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: ['mobile'] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: 'Modo sonho, brincadeira 8: o balão do Pequi\n\n- engine.ts: balão novo',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv.slice(1)
    repo.chamadas.push(argv)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    switch (argv[0]) {
      case 'rev-parse':
        if (argv[1] === '--abbrev-ref') return ok(`${repo.branch}\n`)
        if (argv[1] === '--show-toplevel') return ok('/repo\n')
        if (argv[1] === '--short') return ok('abc1234\n')
        return ok('true\n')
      case 'status':
        return ok(repo.limpo ? '' : repo.arquivos.map(a => ` M ${a}`).join('\n') + '\n')
      case 'diff':
        return ok('diff --git a/src/engine.ts b/src/engine.ts\n+balão\n')
      case 'log':
        return ok('Modo sonho, brincadeira 7 (parte 1): o balão do Pequi\n\x1e')
      case 'commit':
        repo.limpo = true
        return ok()
      default:
        return ok()
    }
  })
  return relogio
}

test('fim de turno com mudanças propõe o commit e envia para a branch', async ($, on) => {
  const repo: Repo = { branch: 'pequi-balao', arquivos: ['src/engine.ts'], chamadas: [], limpo: false }
  const relogio = engine(on, repo)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ reason: 'answer', answer: 'feito', durationMs: 1, isAborted: false, turnId: 't1' })
  await relogio.settle()

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /balão do Pequi/ }))?.text).toBe(
      'Modo sonho, brincadeira 8: o balão do Pequi',
    )
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'enviar' })
  expect(repo.chamadas).toContainEqual(['push', '-u', 'origin', 'pequi-balao'])
  const commit = repo.chamadas.find(c => c[0] === 'commit')
  expect(commit).toEqual(['commit', '-F', '-'])
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Commit abc1234 enviado para origin/pequi-balao.')
  await ui.unmount()
})

test('na main commita mas não envia', async ($, on) => {
  const repo: Repo = { branch: 'main', arquivos: ['src/a.ts'], chamadas: [], limpo: false }
  const relogio = engine(on, repo)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ reason: 'answer', answer: 'feito', durationMs: 1, isAborted: false, turnId: 't1' })
  await relogio.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'enviar' }))?.text).toBe('Commitar (sem push)')
  await ui.press({ key: 'enviar' })
  expect(repo.chamadas.some(c => c[0] === 'push')).toBe(false)
  expect(repo.chamadas.some(c => c[0] === 'commit')).toBe(true)
  await ui.unmount()
})

test('recusa commitar um .env', async ($, on) => {
  const repo: Repo = { branch: 'feature', arquivos: ['.env.local', 'src/a.ts'], chamadas: [], limpo: false }
  const relogio = engine(on, repo)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ reason: 'answer', answer: 'feito', durationMs: 1, isAborted: false, turnId: 't1' })
  await relogio.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'enviar' })
  expect(repo.chamadas.some(c => c[0] === 'commit' || c[0] === 'add')).toBe(false)
  expect((await ui.find({ type: 'Text' }))?.text).toContain('.env.local')
  await ui.unmount()
})

test('árvore limpa não mostra nada', async ($, on) => {
  const repo: Repo = { branch: 'feature', arquivos: [], chamadas: [], limpo: true }
  engine(on, repo)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ reason: 'answer', answer: 'feito', durationMs: 1, isAborted: false, turnId: 't1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('no celular a proposta aparece num painel', async ($, on) => {
  const repo: Repo = { branch: 'pequi-balao', arquivos: ['src/engine.ts'], chamadas: [], limpo: false }
  const relogio = engine(on, repo)
  await $.session.start({ cwd: '/repo', surface: 'mobile', isInteractive: true })
  await $.turn.complete({ reason: 'answer', answer: 'feito', durationMs: 1, isAborted: false, turnId: 't1' })
  await relogio.settle()

  const ui = await $.ui.mount({
    plugin: 'commit-por-etapa',
    component: 'Pane',
    requestId: 'commit',
    surface: 'mobile',
    props: { title: 'Commit da etapa', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect((await ui.find({ type: 'Text', text: /balão do Pequi/ }))?.text).toBe('Modo sonho, brincadeira 8: o balão do Pequi')
  await ui.press({ key: 'enviar' })
  expect(repo.chamadas).toContainEqual(['push', '-u', 'origin', 'pequi-balao'])
  await ui.unmount()
})

test('a faixa do commit deixa as faixas dos outros mods aparecerem', async ($, on) => {
  const repo: Repo = { branch: 'pequi-balao', arquivos: ['src/engine.ts'], chamadas: [], limpo: false }
  const relogio = engine(on, repo)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>outra faixa</Text>
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ reason: 'answer', answer: 'feito', durationMs: 1, isAborted: false, turnId: 't1' })
  await relogio.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /balão/ }))?.text).toBe('Modo sonho, brincadeira 8: o balão do Pequi')
  expect((await ui.find({ type: 'Text', text: /outra/ }))?.text).toBe('outra faixa')
  await ui.unmount()
})
