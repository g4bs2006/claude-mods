import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Resumo, Ultimo } from '../types'

const PANE = 'retomada'
const TITULO = 'Onde parou'

const resumo = atom({ plugin: 'retomada', key: 'resumo' } as const, null as Resumo | null, {
  shape: 'resumo-1',
})
const faixaVisivel = atom({ plugin: 'retomada', key: 'faixaVisivel' } as const, false)
// Montado uma vez por sessão: o prompt do sistema não muda depois disso.
const contexto = atom({ plugin: 'retomada', key: 'contexto' } as const, '')

const chaveUltimo = (repo: string) => `ultimo:${repo}`

async function git($: EngineInterface, args: string[], cwd: string) {
  try {
    const r = await $.process.run(['git', ...args], { cwd })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

function ha(ms: number) {
  const min = Math.max(1, Math.round(ms / 60000))
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 48) return `há ${h} h`
  return `há ${Math.round(h / 24)} d`
}

async function montar($: EngineInterface): Promise<Resumo | null> {
  const repo = await $.session.repo().catch(() => null)
  const cwd = repo?.root ?? (await $.session.cwd())
  const nome = repo?.name ?? cwd.split('/').filter(Boolean).pop() ?? cwd
  const agora = await $.clock.now()
  const guardado = (await $.store.get(chaveUltimo(cwd))) as Ultimo | undefined
  const ultimo = guardado && typeof guardado.resposta === 'string' ? guardado : undefined

  const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd))?.trim()
  if (!branch) {
    return ultimo
      ? { repo: cwd, nome, branch: '', commits: [], naoCommitados: [], adiante: null, atras: null, ultimo, montadoEm: agora }
      : null
  }

  const log = (await git($, ['log', '-5', '--format=%h%x1f%s%x1f%cr'], cwd)) ?? ''
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [hash = '', assunto = '', quando = ''] = l.split('\x1f')
      return { hash, assunto, quando }
    })
  const status = (await git($, ['status', '--porcelain'], cwd)) ?? ''
  const naoCommitados = status
    .split('\n')
    .filter(Boolean)
    .map(l => l.slice(3))
  const contagem = await git($, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd)
  const [atras, adiante] = contagem ? contagem.trim().split(/\s+/).map(Number) : [null, null]
  const docLog = await git($, ['log', '-1', '--format=%cr', '--name-only', '--', 'docs', '*.md'], cwd)
  const [docQuando, ...docArquivos] = (docLog ?? '').split('\n').filter(Boolean)
  const doc = docQuando && docArquivos[0] ? { arquivo: docArquivos[0], quando: docQuando } : undefined

  return {
    repo: cwd,
    nome,
    branch,
    commits,
    naoCommitados,
    adiante: adiante ?? null,
    atras: atras ?? null,
    doc,
    ultimo,
    montadoEm: agora,
  }
}

function linhaGit(r: Resumo) {
  const partes = [r.branch]
  if (r.naoCommitados.length > 0) partes.push(`${r.naoCommitados.length} não commitado(s)`)
  if (r.adiante) partes.push(`${r.adiante} commit(s) sem push`)
  if (r.atras) partes.push(`${r.atras} atrás do remoto`)
  if (r.adiante === null && r.branch) partes.push('sem upstream')
  return partes.filter(Boolean).join(' · ')
}

function textoContexto(r: Resumo) {
  const linhas = [`# Retomada: onde a sessão anterior parou`, '', `Repositório ${r.nome}, ${linhaGit(r)}.`]
  if (r.commits.length > 0) {
    linhas.push('', 'Últimos commits:', ...r.commits.map(c => `- ${c.hash} ${c.assunto} (${c.quando})`))
  }
  if (r.naoCommitados.length > 0) {
    linhas.push('', `Mudanças não commitadas: ${r.naoCommitados.slice(0, 15).join(', ')}`)
  }
  if (r.doc) linhas.push('', `Documento mais recente: ${r.doc.arquivo} (${r.doc.quando}).`)
  if (r.ultimo) {
    linhas.push(
      '',
      `Fim da sua última resposta neste repositório (${ha(r.montadoEm - r.ultimo.quando)}, na branch ${r.ultimo.branch}):`,
      '<<<',
      r.ultimo.resposta,
      '>>>',
    )
  }
  linhas.push('', 'Use isto para continuar de onde parou sem precisar reconstruir o contexto; confirme com o usuário antes de agir sobre algo antigo.')
  return linhas.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'retomada', description: 'Mostra onde a sessão anterior parou' })

    // Um reload do mod roda session.start de novo: o resumo já montado fica.
    if (await read($, resumo)) return started

    const r = await montar($)
    if (!r) return started
    await update($, resumo, () => r)
    await update($, contexto, () => textoContexto(r))
    await update($, faixaVisivel, () => true)
    if (e.surface === 'mobile') void $.ui.open({ id: PANE, title: TITULO })

    return started
  })

  on('command.run', { command: 'retomada' }, async $ => {
    if (!(await read($, resumo))) {
      const r = await montar($)
      if (r) await update($, resumo, () => r)
    }
    await $.ui.open({ id: PANE, title: TITULO })

    return { text: 'Painel "Onde parou" aberto.' }
  })

  // Guarda o fim de cada resposta: o da última vira o ponto de partida da
  // próxima sessão neste repositório.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.reason !== 'answer' || e.agentId || !e.answer.trim()) return ran
    const repo = await $.session.repo().catch(() => null)
    const cwd = repo?.root ?? (await $.session.cwd())
    const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd))?.trim() ?? ''
    const ultimo: Ultimo = {
      resposta: e.answer.trim().slice(-900),
      quando: await $.clock.now(),
      branch,
    }
    await $.store.set(chaveUltimo(cwd), ultimo)

    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (await read($, faixaVisivel)) await update($, faixaVisivel, () => false)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const texto = await read($, contexto)
    if (!texto) return r

    return { ...r, sections: [...r.sections, { id: 'retomada:inicio', scope: 'session' as const, text: texto }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const abaixo = await next(e)
    const r = await read($, resumo)
    if (e.props.hasSurvey || !r || !(await read($, faixaVisivel))) return abaixo

    const { Box, Text, Button } = $.ui.resolve(e)
    const commit = r.commits[0]
    const fim = r.ultimo?.resposta.replace(/\s+/g, ' ').trim()

    return (
      <Box flexDirection="column">
        <Text>
          <Text weight="semibold">Onde parou</Text>
          {r.branch ? ` · ${linhaGit(r)}` : ''}
        </Text>
        {commit && (
          <Text dimColor>
            Último commit: {commit.assunto} ({commit.quando})
          </Text>
        )}
        {r.ultimo && fim && (
          <Text dimColor>
            Fim da última sessão ({ha(r.montadoEm - r.ultimo.quando)}): …{fim.slice(-160)}
          </Text>
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="detalhes" label="Detalhes" onPress={() => $.ui.open({ id: PANE, title: TITULO })} />
          <Button key="ok" label="Ok" role="dismiss" onPress={() => update($, faixaVisivel, () => false)} />
        </Box>
        {abaixo}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const r = await read($, resumo)
    if (!r) return <Text dimColor>Nada para retomar aqui: fora de um repositório e sem sessão anterior.</Text>

    return (
      <Box flexDirection="column">
        <Text weight="semibold">{r.nome}</Text>
        {r.branch && <Text>{linhaGit(r)}</Text>}
        {r.commits.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Últimos commits</Text>
            {r.commits.map(c => (
              <Text key={`c-${c.hash}`}>
                {c.hash} {c.assunto} <Text dimColor>({c.quando})</Text>
              </Text>
            ))}
          </Box>
        )}
        {r.naoCommitados.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Não commitados</Text>
            <Text>{r.naoCommitados.slice(0, 12).join(', ')}{r.naoCommitados.length > 12 ? ` e mais ${r.naoCommitados.length - 12}` : ''}</Text>
          </Box>
        )}
        {r.doc && (
          <Text dimColor>
            Doc mais recente: {r.doc.arquivo} ({r.doc.quando})
          </Text>
        )}
        {r.ultimo && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              Fim da última sessão · {ha(r.montadoEm - r.ultimo.quando)} · {r.ultimo.branch}
            </Text>
            <Markdown text={r.ultimo.resposta} />
          </Box>
        )}
      </Box>
    )
  })
}
