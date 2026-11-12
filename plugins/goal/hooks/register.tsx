import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Etapa, Goal, StatusEtapa } from '../types'

const PANE = 'goal'
const TITULO = 'Goal'
const SECAO = 'goal:atual'

const atual = atom({ plugin: 'goal', key: 'atual' } as const, null as Goal | null, {
  shape: 'goal-1',
})

const MARCA: Record<StatusEtapa, string> = { feita: '✓', andamento: '▸', pendente: '○' }

async function repoRaiz($: EngineInterface) {
  const repo = await $.session.repo().catch(() => null)
  return repo?.root ?? (await $.session.cwd())
}

const chaveStore = (repo: string) => `goal:${repo}`

async function salvar($: EngineInterface, fn: (g: Goal) => Goal | null) {
  const repo = await repoRaiz($)
  const agora = await $.clock.now()
  const novo = await update($, atual, g =>
    fn(g ?? { texto: '', repo, criadoEm: agora, etapas: [], commits: 0 }),
  )
  if (novo) await $.store.set(chaveStore(novo.repo), novo)
  else await $.store.delete(chaveStore(repo))
  return novo
}

function novoGoal(repo: string, texto: string, agora: number, etapas: string[] = []): Goal {
  return {
    texto,
    repo,
    criadoEm: agora,
    commits: 0,
    etapas: etapas.map((titulo, i) => ({ id: `m:${agora}:${i}`, titulo, status: 'pendente' })),
  }
}

function progresso(g: Goal) {
  const total = g.etapas.length
  const feitas = g.etapas.filter(x => x.status === 'feita').length
  return { total, feitas, pct: total === 0 ? 0 : Math.round((feitas / total) * 100) }
}

function barra(pct: number, largura: number) {
  const cheio = Math.round((pct / 100) * largura)
  return '█'.repeat(cheio) + '░'.repeat(largura - cheio)
}

// Commits feitos desde que o goal começou, por qualquer caminho (Claude, o
// mod de commit, o terminal): o git é a fonte, não as chamadas vistas aqui.
async function contarCommits($: EngineInterface, g: Goal) {
  try {
    const r = await $.process.run(
      ['git', 'log', `--since=${new Date(g.criadoEm).toISOString()}`, '--format=%s'],
      { cwd: g.repo },
    )
    if (r.exitCode !== 0) return null
    const linhas = r.stdout.split('\n').filter(Boolean)
    return { commits: linhas.length, ultimoCommit: linhas[0] }
  } catch {
    return null
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'meta',
      description: 'Abre o painel do goal; com texto, define um goal novo',
      argumentHint: '[objetivo]',
    })
    await $.tool.register({
      name: 'goal_definir',
      description:
        'Define o goal (objetivo) da sessão no painel do usuário, com as etapas opcionais. Use quando o usuário disser o que quer alcançar nesta sessão ou pedir para acompanhar um goal. As etapas também entram sozinhas quando você usa TaskCreate/TaskUpdate.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'O objetivo em uma frase' },
          etapas: { type: 'array', items: { type: 'string' }, description: 'Etapas, em ordem' },
        },
        required: ['goal'],
      },
      isDeferred: false,
    })

    const ja = await read($, atual)
    if (!ja) {
      const repo = await repoRaiz($)
      const guardado = (await $.store.get(chaveStore(repo))) as Goal | undefined
      if (guardado && !guardado.concluidoEm && Array.isArray(guardado.etapas)) {
        await update($, atual, () => guardado)
      }
    }
    const g = await read($, atual)
    if (g && (g.texto || g.etapas.length > 0)) {
      const { feitas, total } = progresso(g)
      $.ui.toast(`Goal em andamento: ${g.texto || 'sem título'} · ${feitas}/${total}`)
      void $.ui.open({ id: PANE, title: TITULO })
    }

    return started
  })

  on('command.run', { command: 'meta' }, async ($, e) => {
    const texto = e.args.trim()
    if (texto) {
      const repo = await repoRaiz($)
      const agora = await $.clock.now()
      const anterior = await read($, atual)
      // As etapas já abertas continuam valendo: só troca o objetivo e reinicia
      // a contagem se o goal anterior já tinha sido concluído.
      await salvar($, () =>
        anterior && !anterior.concluidoEm
          ? { ...anterior, texto }
          : novoGoal(repo, texto, agora),
      )
    }
    await $.ui.open({ id: PANE, title: TITULO })

    return { text: texto ? `Goal: ${texto}` : 'Painel do goal aberto.' }
  })

  on('tool.call', { tool: 'mcp__goal__goal_definir' }, async ($, e) => {
    const texto = String(e.goal ?? '').trim().slice(0, 200)
    if (!texto) return { deny: 'goal vazio' }
    const etapas = Array.isArray(e.etapas) ? e.etapas.map(x => String(x).slice(0, 120)) : []
    const repo = await repoRaiz($)
    const agora = await $.clock.now()
    await salvar($, g => {
      const base = g.concluidoEm ? novoGoal(repo, texto, agora) : { ...g, texto }
      const novas = novoGoal(repo, texto, agora, etapas).etapas
      return { ...base, etapas: [...base.etapas, ...novas] }
    })
    void $.ui.open({ id: PANE, title: TITULO })

    return { result: `Goal definido: ${texto}${etapas.length ? ` (${etapas.length} etapas)` : ''}` }
  })

  // As tasks do Claude viram as etapas do goal.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && !ran.isError ? ran.result?.task?.id : undefined
    if (id) {
      const sessao = await $.session.id()
      await salvar($, g => ({
        ...g,
        etapas: [...g.etapas, { id: `${sessao}:${id}`, titulo: e.subject.slice(0, 120), status: 'pendente' }],
      }))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const sessao = await $.session.id()
    const id = `${sessao}:${e.taskId}`
    const agora = await $.clock.now()
    const status: StatusEtapa | 'apagar' | undefined =
      e.status === 'completed'
        ? 'feita'
        : e.status === 'in_progress'
          ? 'andamento'
          : e.status === 'pending'
            ? 'pendente'
            : e.status === 'deleted'
              ? 'apagar'
              : undefined
    const g = await read($, atual)
    if (g?.etapas.some(x => x.id === id)) {
      await salvar($, g =>
        status === 'apagar'
          ? { ...g, etapas: g.etapas.filter(x => x.id !== id) }
          : {
              ...g,
              etapas: g.etapas.map(x =>
                x.id === id
                  ? {
                      ...x,
                      titulo: e.subject ? e.subject.slice(0, 120) : x.titulo,
                      status: status ?? x.status,
                      feitaEm: status === 'feita' ? agora : x.feitaEm,
                    }
                  : x,
              ),
            },
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  // O TodoWrite (a lista antiga) troca a lista inteira de uma vez.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const agora = await $.clock.now()
    await salvar($, g => {
      const fora = g.etapas.filter(x => !x.id.startsWith('todo:'))
      const todos: Etapa[] = e.todos.map(t => ({
        id: `todo:${t.content}`,
        titulo: t.content.slice(0, 120),
        status: t.status === 'completed' ? 'feita' : t.status === 'in_progress' ? 'andamento' : 'pendente',
        feitaEm: t.status === 'completed' ? agora : undefined,
      }))
      return { ...g, etapas: [...fora, ...todos] }
    })

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const g = await read($, atual)
    if (g && !g.concluidoEm) {
      const c = await contarCommits($, g)
      if (c && (c.commits !== g.commits || c.ultimoCommit !== g.ultimoCommit)) {
        await salvar($, x => ({ ...x, ...c }))
      }
      const { feitas, total } = progresso(g)
      if (total > 0 && feitas === total) $.ui.toast('Todas as etapas do goal estão feitas')
    }

    return ran
  })

  // O goal entra no prompt do sistema só pelo texto, que muda raramente: as
  // etapas ficam fora para não invalidar o cache a cada task marcada.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const g = await read($, atual)
    if (!g?.texto || g.concluidoEm) return r

    return {
      ...r,
      sections: [
        ...r.sections,
        {
          id: SECAO,
          scope: 'session' as const,
          text: `# Goal da sessão\n\nO usuário acompanha este objetivo num painel: "${g.texto}". Divida o trabalho em etapas com TaskCreate e marque o andamento com TaskUpdate; elas aparecem no painel como o progresso do goal.`,
        },
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const g = await read($, atual)
    const largura = Math.max(10, Math.min(30, (e.props.bodyColumns ?? 40) - 12))

    if (!g || (!g.texto && g.etapas.length === 0)) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Nenhum goal ainda.</Text>
          <Text dimColor>Defina com /meta &lt;objetivo&gt;, ou peça ao Claude para acompanhar um goal.</Text>
        </Box>
      )
    }

    const { total, feitas, pct } = progresso(g)
    const alternar = (id: string) => async () => {
      const agora = await $.clock.now()
      await salvar($, x => ({
        ...x,
        etapas: x.etapas.map(et =>
          et.id === id
            ? et.status === 'feita'
              ? { ...et, status: 'pendente', feitaEm: undefined }
              : { ...et, status: 'feita', feitaEm: agora }
            : et,
        ),
      }))
    }
    const concluir = async () => {
      const agora = await $.clock.now()
      await salvar($, x => ({ ...x, concluidoEm: agora }))
      $.ui.toast(`Goal concluído: ${g.texto || 'sem título'}`)
    }
    const limpar = () => salvar($, () => null)
    const ordem: StatusEtapa[] = ['andamento', 'pendente', 'feita']
    const etapas = [...g.etapas].sort((a, b) => ordem.indexOf(a.status) - ordem.indexOf(b.status))

    return (
      <Box flexDirection="column">
        {g.texto ? (
          <Text weight="semibold">{g.texto}</Text>
        ) : (
          <Text dimColor>Sem objetivo escrito: /meta &lt;objetivo&gt;</Text>
        )}
        {g.concluidoEm ? (
          <Text>Concluído ✓</Text>
        ) : (
          <Text>
            {barra(pct, largura)} {feitas}/{total} · {pct}%
          </Text>
        )}
        <Box flexDirection="column" marginTop={1}>
          {etapas.length === 0 && <Text dimColor>As etapas aparecem aqui quando o Claude cria tasks.</Text>}
          {etapas.map(et => (
            <Button key={`et-${et.id}`} plain onPress={alternar(et.id)}>
              {MARCA[et.status]} {et.status === 'feita' ? <Text dimColor>{et.titulo}</Text> : et.titulo}
            </Button>
          ))}
        </Box>
        {g.commits > 0 && (
          <Text dimColor>
            {g.commits} commit(s) desde o início{g.ultimoCommit ? ` · último: ${g.ultimoCommit}` : ''}
          </Text>
        )}
        <Box flexDirection="row" gap={1} marginTop={1}>
          {!g.concluidoEm && (
            <Button
              key="concluir"
              label="Concluir goal"
              variant={total > 0 && feitas === total ? 'primary' : undefined}
              onPress={concluir}
            />
          )}
          <Button key="limpar" label="Limpar" onPress={limpar} />
        </Box>
      </Box>
    )
  })
}
