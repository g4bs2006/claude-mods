import { expect, mock, test } from 'claude-code/testing'

type OnTeste = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

const BAND = {
  plugin: 'deploy-ci',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const
const PANE = {
  plugin: 'deploy-ci',
  component: 'Pane',
  requestId: 'deploy',
  props: { title: 'Deploy e CI', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const SHA = 'abc1234def5678abc1234def5678abc1234def56'
const AGORA = 1_700_000_000_000

function engine(on: OnTeste, ciTermina: 'verde' | 'falha', temGh = true) {
  const relogio = mock.clock(on, { now: AGORA })
  mock.store(on)
  const avisos: string[] = []
  let consultas = 0
  on('command.register', () => ({ value: { command: 'deploy' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', (_, e) => {
    avisos.push((e as { text: string }).text)
    return { value: { isSent: true, channel: 'x' } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('env.get', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const a = argv.join(' ')
    if (argv[0] === 'gh') {
      if (!temGh) throw new Error('ENOENT')
      if (a.includes('check-runs')) {
        consultas++
        const fim = consultas >= 2
        return out(JSON.stringify({
          check_runs: [
            { name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/1' },
            { name: 'build', status: fim ? 'completed' : 'in_progress', conclusion: fim ? (ciTermina === 'verde' ? 'success' : 'failure') : null, html_url: 'https://github.com/x/2' },
          ],
        }))
      }
      return out(JSON.stringify({ statuses: [{ context: 'Vercel', state: 'success', target_url: 'https://pequidev.vercel.app' }] }))
    }
    if (a === 'git rev-parse HEAD' || a === 'git rev-parse @{u}') return out(`${SHA}\n`)
    if (a.startsWith('git log -1')) return out(`${Math.floor(AGORA / 1000) - 60}\n`)
    if (a.startsWith('git remote')) return out('git@github.com:g4bs2006/PequiDev.git\n')
    if (a.includes('--abbrev-ref')) return out('pequi-balao\n')
    if (a.includes('--show-toplevel')) return out('/repo\n')
    return out('', 1)
  })
  return { relogio, avisos }
}

test('depois do push acompanha até ficar verde e avisa', async ($, on) => {
  const { relogio, avisos } = engine(on, 'verde')
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push -u origin pequi-balao' })
  await relogio.settle()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /abc1234/ }))?.text).toContain('⏳ 1 · ✅ 2 · ❌ 0')
  await band.unmount()

  await relogio.advance(20_000)
  expect(avisos).toEqual(['✅ abc1234 em pequi-balao: CI e deploy verdes (3 checks)'])

  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await ui.find({ type: 'Text', text: /Vercel/ }))?.text).toBe('✅ Vercel')
  await ui.unmount()

  // O mesmo commit não é avisado de novo no fim do turno.
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' })
  await relogio.advance(60_000)
  expect(avisos).toHaveLength(1)
})

test('uma falha no build avisa com o nome do check', async ($, on) => {
  const { relogio, avisos } = engine(on, 'falha')
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' })
  await relogio.settle()
  await relogio.advance(20_000)
  expect(avisos).toEqual(['❌ abc1234 em pequi-balao: falhou build'])
})

test('sem gh nem token, diz como dar acesso', async ($, on) => {
  const { relogio } = engine(on, 'verde', false)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await relogio.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /gh auth login/ }))?.text).toContain('GH_TOKEN')
  await band.unmount()
})
