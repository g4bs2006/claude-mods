import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, EstadoCheck, Vigia } from '../types'

const PANE = 'deploy'
const TITULO = 'Deploy e CI'
const INTERVALO = 20_000
const LIMITE = 30 * 60_000
const SEM_CHECKS = 3 * 60_000
// Um commit mais velho que isto, achado já enviado, não é um push desta sessão.
const RECENTE = 2 * 60 * 60_000

const vigia = atom({ plugin: 'deploy-ci', key: 'vigia' } as const, null as Vigia | null, {
  shape: 'vigia-1',
})
const oculto = atom({ plugin: 'deploy-ci', key: 'oculto' } as const, false)

const ICONE: Record<EstadoCheck, string> = { pendente: '⏳', ok: '✅', falhou: '❌', neutro: '➖' }

// Cada vigia nova aposenta a anterior; um reload do mod zera isto e
// session.start retoma a vigia em andamento.
let geracao = 0

async function git($: EngineInterface, args: string[], cwd?: string) {
  try {
    const r = await $.process.run(['git', ...args], cwd ? { cwd } : {})
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

type Bruto = {
  check_runs?: { name: string; status: string; conclusion: string | null; html_url?: string; details_url?: string }[]
  statuses?: { context: string; state: string; target_url?: string | null }[]
}

function juntar(runs: Bruto, status: Bruto): Check[] {
  const checks: Check[] = (runs.check_runs ?? []).map(r => ({
    nome: r.name,
    estado:
      r.status !== 'completed'
        ? 'pendente'
        : r.conclusion === 'success'
          ? 'ok'
          : r.conclusion === 'neutral' || r.conclusion === 'skipped'
            ? 'neutro'
            : 'falhou',
    url: r.details_url || r.html_url,
  }))
  // O status combinado lista o mais recente primeiro: fica um por contexto.
  const vistos = new Set<string>()
  for (const s of status.statuses ?? []) {
    if (vistos.has(s.context)) continue
    vistos.add(s.context)
    checks.push({
      nome: s.context,
      estado: s.state === 'success' ? 'ok' : s.state === 'pending' ? 'pendente' : 'falhou',
      url: s.target_url ?? undefined,
    })
  }
  return checks
}

// Primeiro o gh (já autenticado na máquina); sem ele, um token do ambiente.
async function consultar($: EngineInterface, repo: string, sha: string): Promise<Check[] | string> {
  const caminhos = [`repos/${repo}/commits/${sha}/check-runs?per_page=100`, `repos/${repo}/commits/${sha}/status?per_page=100`]
  try {
    const [a, b] = await Promise.all(
      caminhos.map(c => $.process.run(['gh', 'api', c], { timeoutMs: 20_000 })),
    )
    if (a && b && a.exitCode === 0 && b.exitCode === 0) {
      return juntar(JSON.parse(a.stdout) as Bruto, JSON.parse(b.stdout) as Bruto)
    }
  } catch {
    // gh ausente ou saída inesperada: tenta o token
  }
  const token = (await $.env.get('GH_TOKEN')) ?? (await $.env.get('GITHUB_TOKEN'))
  if (!token) return 'Sem acesso ao GitHub: instale o gh e rode "gh auth login", ou defina GH_TOKEN.'
  try {
    const [a, b] = await Promise.all(
      caminhos.map(c =>
        $.http.fetch(`https://api.github.com/${c}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        }),
      ),
    )
    if (!a || !b || !a.ok || !b.ok) return `O GitHub respondeu ${a?.status ?? '?'} / ${b?.status ?? '?'}.`
    return juntar(JSON.parse(a.text) as Bruto, JSON.parse(b.text) as Bruto)
  } catch (erro) {
    return `Falha ao consultar o GitHub: ${String(erro).slice(0, 120)}`
  }
}

function contar(checks: Check[]) {
  const n = (e: EstadoCheck) => checks.filter(c => c.estado === e).length
  return { pendente: n('pendente'), ok: n('ok'), falhou: n('falhou') }
}

async function avisar($: EngineInterface, v: Vigia) {
  const falhas = v.checks.filter(c => c.estado === 'falhou').map(c => c.nome)
  const texto =
    v.fase === 'verde'
      ? `✅ ${v.curto} em ${v.branch}: CI e deploy verdes (${v.checks.length} checks)`
      : v.fase === 'falhou'
        ? `❌ ${v.curto} em ${v.branch}: falhou ${falhas.join(', ')}`
        : v.fase === 'tempo'
          ? `⏳ ${v.curto} em ${v.branch}: ainda pendente depois de 30 min`
          : undefined
  if (!texto) return
  $.ui.toast(texto)
  await $.ui.notify(texto, { title: TITULO, key: v.sha }).catch(() => undefined)
  const vistos = ((await $.store.get('avisados')) as string[] | undefined) ?? []
  await $.store.set('avisados', [...vistos.filter(s => s !== v.sha), v.sha].slice(-50))
}

async function vigiar($: EngineInterface, inicial: Vigia) {
  const minha = ++geracao
  await update($, vigia, () => inicial)
  await update($, oculto, () => false)
  const superficies: readonly string[] = await $.session.surfaces().catch(() => [])
  if (superficies.includes('mobile')) void $.ui.open({ id: PANE, title: TITULO })

  while (minha === geracao) {
    const atual = await read($, vigia)
    if (!atual || atual.sha !== inicial.sha) return
    const agora = await $.clock.now()
    const resposta = await consultar($, atual.repo, atual.sha)

    if (typeof resposta === 'string') {
      await update($, vigia, v => (v ? { ...v, fase: 'sem-acesso' as const, detalhe: resposta } : v))
      return
    }
    const { pendente, falhou } = contar(resposta)
    const decorrido = agora - atual.inicio
    const fase: Vigia['fase'] =
      resposta.length === 0
        ? decorrido > SEM_CHECKS
          ? 'sem-checks'
          : 'vigiando'
        : pendente > 0
          ? decorrido > LIMITE
            ? 'tempo'
            : 'vigiando'
          : falhou > 0
            ? 'falhou'
            : 'verde'
    if (minha !== geracao) return
    const nova = await update($, vigia, v => (v ? { ...v, checks: resposta, fase, detalhe: undefined } : v))
    if (fase !== 'vigiando') {
      if (nova) await avisar($, nova)
      return
    }
    await $.clock.sleep(INTERVALO)
  }
}

// Olha se HEAD acabou de chegar ao remoto e, se for novo, começa a vigiar.
async function conferirPush($: EngineInterface, forcar = false) {
  const sha = await git($, ['rev-parse', 'HEAD'])
  const remoto = await git($, ['rev-parse', '@{u}'])
  if (!sha || sha !== remoto) return 'O commit atual ainda não está no remoto.'
  const atual = await read($, vigia)
  if (!forcar && atual?.sha === sha) return 'Já estou acompanhando este commit.'
  const avisados = ((await $.store.get('avisados')) as string[] | undefined) ?? []
  const agora = await $.clock.now()
  const quando = Number(await git($, ['log', '-1', '--format=%ct'])) * 1000
  if (!forcar && (avisados.includes(sha) || agora - quando > RECENTE)) return 'Nada novo enviado.'

  const url = await git($, ['remote', 'get-url', 'origin'])
  const achado = url ? /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url) : null
  if (!achado) return 'O remoto não é do GitHub.'
  const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? ''
  const cwd = (await git($, ['rev-parse', '--show-toplevel'])) ?? ''

  void vigiar($, {
    sha,
    curto: sha.slice(0, 7),
    branch,
    repo: `${achado[1]}/${achado[2]}`,
    cwd,
    inicio: agora,
    fase: 'vigiando',
    checks: [],
  }).catch(() => undefined)

  return `Acompanhando ${sha.slice(0, 7)} em ${branch}.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'deploy',
      description: 'Mostra o CI e o deploy do último commit enviado (e volta a acompanhar)',
    })
    const v = await read($, vigia)
    if (v?.fase === 'vigiando') void vigiar($, v).catch(() => undefined)

    return started
  })

  on('command.run', { command: 'deploy' }, async $ => {
    const texto = await conferirPush($, true)
    await $.ui.open({ id: PANE, title: TITULO })

    return { text: texto }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\s+push\b/.test(e.command) && ran.deny === undefined && !ran.isError) {
      await conferirPush($).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Pega também o push feito por outro mod ou no terminal.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await conferirPush($).catch(() => undefined)

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const abaixo = await next(e)
    const v = await read($, vigia)
    if (e.props.hasSurvey || !v || (await read($, oculto))) return abaixo

    const { Box, Text, Button } = $.ui.resolve(e)
    const { pendente, ok, falhou } = contar(v.checks)
    const falhas = v.checks.filter(c => c.estado === 'falhou').map(c => c.nome)
    const resumo =
      v.fase === 'sem-acesso'
        ? v.detalhe
        : v.fase === 'sem-checks'
          ? 'nenhum check ou deploy apareceu'
          : v.checks.length === 0
            ? 'esperando os checks aparecerem…'
            : `⏳ ${pendente} · ✅ ${ok} · ❌ ${falhou}${falhas.length ? ` (${falhas.join(', ')})` : ''}`
    const titulo =
      v.fase === 'verde' ? '✅ Verde' : v.fase === 'falhou' ? '❌ Falhou' : v.fase === 'tempo' ? '⏳ Demorando' : 'CI/deploy'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text>
            <Text weight="semibold">{titulo}</Text> · {v.curto} em {v.branch}: {resumo}
          </Text>
          <Button key="detalhes" label="Detalhes" onPress={() => $.ui.open({ id: PANE, title: TITULO })} />
          <Button key="ocultar" label="Ok" role="dismiss" onPress={() => update($, oculto, () => true)} />
        </Box>
        {abaixo}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const v = await read($, vigia)
    if (!v) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Nenhum push acompanhado nesta sessão.</Text>
          <Text dimColor>Depois de um git push o CI e o deploy aparecem aqui; /deploy confere o commit atual.</Text>
        </Box>
      )
    }
    const ordem: EstadoCheck[] = ['falhou', 'pendente', 'ok', 'neutro']
    const checks = [...v.checks].sort((a, b) => ordem.indexOf(a.estado) - ordem.indexOf(b.estado))

    return (
      <Box flexDirection="column">
        <Text weight="semibold">
          {v.curto} · {v.branch} · {v.repo}
        </Text>
        <Text dimColor>
          {v.fase === 'vigiando' ? 'acompanhando…' : v.fase === 'verde' ? 'tudo verde' : v.fase === 'falhou' ? 'com falha' : v.fase === 'tempo' ? 'ainda pendente depois de 30 min' : v.fase === 'sem-checks' ? 'nenhum check apareceu' : 'sem acesso'}
        </Text>
        {v.detalhe && <Text>{v.detalhe}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {checks.map((c, i) => (
            <Box key={`c-${i}`} flexDirection="row" gap={1}>
              <Text>
                {ICONE[c.estado]} {c.nome}
              </Text>
              {c.url && /^https?:\/\//.test(c.url) && <Link href={c.url} label="abrir" />}
            </Box>
          ))}
        </Box>
        {v.fase !== 'vigiando' && (
          <Button key="de-novo" label="Conferir de novo" onPress={() => conferirPush($, true)} />
        )}
      </Box>
    )
  })
}
