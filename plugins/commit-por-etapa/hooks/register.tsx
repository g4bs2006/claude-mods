import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResolveInput } from 'claude-code'

import type { Proposta } from '../types'

const proposta = atom(
  { plugin: 'commit-por-etapa', key: 'proposta' } as const,
  null as Proposta | null,
  { shape: 'proposta-1' },
)
// A assinatura das mudanças que a pessoa dispensou: não propõe de novo
// enquanto o diff continuar o mesmo.
const dispensada = atom({ plugin: 'commit-por-etapa', key: 'dispensada' } as const, '')

const PANE = 'commit'
const TITULO = 'Commit da etapa'
const PROTEGIDAS = /^(main|master|production|prod)$/
const SEGREDO = /(^|\/)\.env(?!\.example$)(\.|$)/
const LIMITE_DIFF = 14000

type Git = { ok: boolean; out: string; err: string }

async function git($: EngineInterface, args: string[], init: { stdin?: string; timeoutMs?: number } = {}): Promise<Git> {
  try {
    const r = await $.process.run(['git', ...args], init)
    return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr }
  } catch (erro) {
    return { ok: false, out: '', err: String(erro) }
  }
}

// Um hash curto do estado do diff: muda quando qualquer arquivo muda.
function hash(texto: string) {
  let h = 5381
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

async function estado($: EngineInterface) {
  const dentro = await git($, ['rev-parse', '--is-inside-work-tree'])
  if (!dentro.ok) return null
  const status = await git($, ['status', '--porcelain', '--untracked-files=all'])
  const linhas = status.out.split('\n').filter(Boolean)
  if (linhas.length === 0) return null
  const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()
  const cwd = (await git($, ['rev-parse', '--show-toplevel'])).out.trim()
  const diff = await git($, ['diff', 'HEAD', '--no-color'])
  const arquivos = linhas.map(l => l.slice(3).replace(/^.* -> /, ''))
  return {
    cwd,
    branch,
    arquivos,
    diff: diff.out,
    assinatura: hash(status.out + diff.out),
  }
}

async function gerar($: EngineInterface, forcar = false) {
  const agora = await estado($)
  if (!agora) {
    await update($, proposta, () => null)
    return
  }
  const atual = await read($, proposta)
  if (!forcar) {
    if (agora.assinatura === (await read($, dispensada))) return
    if (atual && atual.assinatura === agora.assinatura && atual.fase !== 'erro') return
  }

  await update($, proposta, () => ({
    cwd: agora.cwd,
    branch: agora.branch,
    assinatura: agora.assinatura,
    arquivos: agora.arquivos,
    mensagem: '',
    fase: 'gerando' as const,
  }))

  const historico = (await git($, ['log', '-12', '--format=%B%x1e'])).out
    .split('\x1e')
    .map(m => m.trim())
    .filter(Boolean)
    // Os exemplos sem as linhas de coautoria: o estilo é o do assunto e do corpo.
    .map(m => m.replace(/\n*(Co-Authored-By|Claude-Session):.*$/gims, '').trim())
    .slice(0, 8)
  const diff =
    agora.diff.length > LIMITE_DIFF
      ? `${agora.diff.slice(0, LIMITE_DIFF)}\n[diff cortado]`
      : agora.diff
  const novos = agora.arquivos.filter(a => !agora.diff.includes(`b/${a}`))

  const prompt = `Escreva a mensagem de commit para as mudanças abaixo, imitando o estilo das mensagens anteriores deste repositório (idioma, tom, forma do assunto, se há corpo e como ele é escrito).

Regras:
- Assunto curto (até ~72 caracteres), sem ponto final. Se as mensagens anteriores numeram etapas de uma série (por exemplo "Modo sonho, brincadeira 7 (parte 1): ..."), continue a numeração quando a mudança for a etapa seguinte.
- Corpo opcional, no formato que as anteriores usam (por exemplo, itens "- arquivo: o que mudou").
- Não invente o que não está no diff. Não adicione linhas de coautoria.
- Responda só com a mensagem, sem cercas de código nem comentários.

Mensagens anteriores (mais recente primeiro):
${historico.map(m => `---\n${m}`).join('\n')}
---

Branch: ${agora.branch}
Arquivos alterados: ${agora.arquivos.join(', ')}
${novos.length > 0 ? `Arquivos novos (sem diff abaixo): ${novos.join(', ')}\n` : ''}
Diff:
${diff}`

  const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 600 })
  const texto = r.isAnswered ? r.text.replace(/^```\w*\n?|```$/g, '').trim() : ''

  // Se o diff mudou enquanto o modelo escrevia, a proposta já é velha.
  const depois = await read($, proposta)
  if (!depois || depois.assinatura !== agora.assinatura) return

  if (texto) {
    const superficies: readonly string[] = await $.session.surfaces().catch(() => [])
    if (superficies.includes('mobile')) void $.ui.open({ id: PANE, title: TITULO })
  }
  await update($, proposta, p =>
    p
      ? texto
        ? { ...p, mensagem: texto, fase: 'pronta' as const }
        : { ...p, fase: 'erro' as const, detalhe: `Não consegui gerar a mensagem (${r.isAnswered ? 'vazia' : r.reason}).` }
      : p,
  )
}

async function commitar($: EngineInterface, enviar: boolean, mensagemManual?: string) {
  const p = await read($, proposta)
  if (!p) return 'Nada para commitar.'
  const mensagem = (mensagemManual ?? p.mensagem).trim()
  if (!mensagem) return 'A proposta ainda não tem mensagem.'

  const agora = await estado($)
  if (!agora) {
    await update($, proposta, () => null)
    return 'A árvore já está limpa.'
  }
  if (agora.assinatura !== p.assinatura && mensagemManual === undefined) {
    void gerar($, true)
    return 'As mudanças mudaram desde a proposta; gerei outra.'
  }
  const segredos = agora.arquivos.filter(a => SEGREDO.test(a))
  if (segredos.length > 0) {
    await update($, proposta, x => (x ? { ...x, fase: 'erro' as const, detalhe: `Recusado: ${segredos.join(', ')} parece arquivo de segredos.` } : x))
    return 'Recusado: há arquivo .env entre as mudanças.'
  }

  await update($, proposta, x => (x ? { ...x, fase: 'commitando' as const, detalhe: undefined } : x))
  const add = await git($, ['add', '-A'])
  const commit = add.ok ? await git($, ['commit', '-F', '-'], { stdin: `${mensagem}\n` }) : add
  if (!commit.ok) {
    await update($, proposta, x => (x ? { ...x, fase: 'erro' as const, detalhe: (commit.err || commit.out).trim().slice(0, 300) } : x))
    return 'O commit falhou.'
  }
  const sha = (await git($, ['rev-parse', '--short', 'HEAD'])).out.trim()

  if (!enviar) {
    await update($, proposta, x => (x ? { ...x, fase: 'feito' as const, detalhe: `Commit ${sha} em ${x.branch}, sem push.` } : x))
    return `Commit ${sha} feito.`
  }
  if (agora.branch === 'HEAD' || PROTEGIDAS.test(agora.branch)) {
    await update($, proposta, x => (x ? { ...x, fase: 'feito' as const, detalhe: `Commit ${sha} feito. Push não enviado: ${agora.branch} é protegida.` } : x))
    return `Commit ${sha} feito; push não enviado (${agora.branch}).`
  }

  await update($, proposta, x => (x ? { ...x, fase: 'enviando' as const } : x))
  let push: Git = { ok: false, out: '', err: '' }
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    if (tentativa > 0) await $.clock.sleep(2000 * 2 ** (tentativa - 1))
    push = await git($, ['push', '-u', 'origin', agora.branch], { timeoutMs: 90000 })
    if (push.ok) break
    // Só vale tentar de novo em erro de rede; recusa do remoto não muda.
    if (!/Could not resolve|timed out|Connection|reset|unexpected disconnect|RPC failed|502|503|504/i.test(push.err)) break
  }
  await update($, proposta, x =>
    x
      ? push.ok
        ? { ...x, fase: 'feito' as const, detalhe: `Commit ${sha} enviado para origin/${x.branch}.` }
        : { ...x, fase: 'erro' as const, detalhe: `Commit ${sha} feito, mas o push falhou: ${push.err.trim().split('\n').slice(-2).join(' ').slice(0, 260)}` }
      : x,
  )
  if (push.ok) $.ui.toast(`Commit ${sha} enviado para ${agora.branch}`)

  return push.ok ? `Commit ${sha} enviado para ${agora.branch}.` : `Commit ${sha} feito; o push falhou.`
}

function desenhar($: EngineInterface, e: ResolveInput<'AbovePrompt' | 'Pane'>, p: Proposta) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const protegida = p.branch === 'HEAD' || PROTEGIDAS.test(p.branch)
  const [assunto, ...corpo] = p.mensagem.split('\n')
  const corpoCurto = corpo.join('\n').trim().split('\n').slice(0, 4).join('\n')
  const fechar = () =>
    p.fase === 'feito' || p.fase === 'erro'
      ? update($, proposta, () => null)
      : Promise.all([update($, dispensada, () => p.assinatura), update($, proposta, () => null)])

  const cabecalho = `Commit da etapa · ${p.branch} · ${p.arquivos.length} arquivo(s)`

  if (p.fase === 'gerando' || p.fase === 'commitando' || p.fase === 'enviando') {
    const texto = { gerando: 'escrevendo a mensagem…', commitando: 'commitando…', enviando: 'enviando…' }[p.fase]
    return (
      <Text dimColor>
        {cabecalho} · {texto}
      </Text>
    )
  }

  if (p.fase === 'feito' || p.fase === 'erro') {
    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor={p.fase === 'feito'}>{p.detalhe}</Text>
        {p.fase === 'erro' && <Button key="tentar" label="Gerar de novo" onPress={() => gerar($, true)} />}
        <Button key="ok" label="Ok" role="dismiss" onPress={fechar} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{cabecalho}</Text>
      <Text weight="semibold">{assunto}</Text>
      {corpoCurto && <Text dimColor>{corpoCurto}</Text>}
      <Box flexDirection="row" gap={1}>
        <Button
          key="enviar"
          label={protegida ? 'Commitar (sem push)' : 'Commitar e enviar'}
          variant="primary"
          onPress={() => commitar($, !protegida)}
        />
        {!protegida && <Button key="so-commit" label="Só commitar" onPress={() => commitar($, false)} />}
        <Button key="outra" label="Outra mensagem" onPress={() => gerar($, true)} />
        <Button key="agora-nao" label="Agora não" role="dismiss" onPress={fechar} />
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'commit-etapa',
      description: 'Propõe o commit da etapa agora; com texto, commita e envia com essa mensagem',
      argumentHint: '[mensagem]',
    })

    return started
  })

  on('command.run', { command: 'commit-etapa' }, async ($, e) => {
    const texto = e.args.trim()
    if (texto) {
      await gerar($, false)
      if (!(await read($, proposta))) return { text: 'Nada para commitar: a árvore está limpa.' }
      return { text: await commitar($, true, texto) }
    }
    await update($, dispensada, () => '')
    void gerar($, true)
    await $.ui.open({ id: PANE, title: TITULO })

    return { text: 'Gerando a proposta de commit.' }
  })

  // Fim de turno com mudanças = etapa possivelmente pronta. Roda fora do
  // caminho do turno: o modelo pequeno escreve a mensagem em segundo plano.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.reason === 'answer') void gerar($).catch(() => undefined)

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const abaixo = await next(e)
    const p = await read($, proposta)
    if (!p || e.props.hasSurvey) return abaixo

    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {desenhar($, e, p)}
        {abaixo}
      </Box>
    )
  })

  // No celular a faixa acima do prompt não aparece: a mesma proposta num painel.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const p = await read($, proposta)
    if (!p) {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Nada para commitar agora.</Text>
    }

    return desenhar($, e, p)
  })
}
