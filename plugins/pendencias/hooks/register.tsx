import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pendencia } from '../types'

const PANE = 'pendencias'
const TITULO = 'Pendências'
const CHAVE = 'itens'
const LIMITE = 120
const DIA = 24 * 60 * 60 * 1000

const itens = atom({ plugin: 'pendencias', key: 'itens' } as const, [] as Pendencia[], {
  shape: 'itens-1',
})
const sessaoAtual = atom({ plugin: 'pendencias', key: 'sessao' } as const, '')
const faixaOculta = atom({ plugin: 'pendencias', key: 'faixaOculta' } as const, false)
// O texto que entra no prompt do sistema, montado uma vez no início: estável,
// para não invalidar o cache a cada pendência que muda.
const contexto = atom({ plugin: 'pendencias', key: 'contexto' } as const, '')

// Só pede ao modelo pequeno quando o fim da resposta parece pedir algo.
const PEDE_ALGO =
  /\?|aprov|confirm|autoriz|preciso que|você precisa|voce precisa|aguard|pendente|falta você|rode |rodar |execute|merge|responda|decid|escolh|quer que|posso |OK para|ok para/i

const abertas = (lista: Pendencia[]) => lista.filter(x => !x.resolvidaEm)

async function projetoAtual($: EngineInterface) {
  const repo = await $.session.repo().catch(() => null)
  if (repo?.name) return repo.name
  const cwd = await $.session.cwd()
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

// O store é dividido entre sessões abertas ao mesmo tempo: relê antes de
// escrever, para uma sessão não apagar o que a outra acabou de guardar.
async function salvar($: EngineInterface, fn: (lista: Pendencia[]) => Pendencia[]) {
  const guardadas = ((await $.store.get(CHAVE)) as Pendencia[] | undefined) ?? []
  const agora = await $.clock.now()
  const nova = fn(Array.isArray(guardadas) ? guardadas : [])
    // Resolvidas somem depois de uma semana.
    .filter(x => !x.resolvidaEm || agora - x.resolvidaEm < 7 * DIA)
    .slice(-LIMITE)
  await $.store.set(CHAVE, nova)
  await update($, itens, () => nova)
  return nova
}

async function recarregar($: EngineInterface) {
  const guardadas = (await $.store.get(CHAVE)) as Pendencia[] | undefined
  if (Array.isArray(guardadas)) await update($, itens, () => guardadas)
}

function idade(ms: number) {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} d`
}

async function extrair($: EngineInterface, resposta: string): Promise<string[] | null> {
  const fim = resposta.slice(-2500)
  if (!PEDE_ALGO.test(fim)) return []
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 400,
    prompt: `Abaixo está o fim da resposta de um assistente de programação ao usuário.

Liste somente as ações que dependem do USUÁRIO para o trabalho seguir: aprovar algo, responder uma pergunta feita a ele, decidir entre opções, rodar um comando ou migração, fazer um merge, conferir algo no celular ou no navegador. Não liste o que o assistente vai fazer, nem sugestões opcionais ("se quiser, posso..."), nem o que já foi feito.

Cada item: uma frase curta no imperativo, em português, até 100 caracteres, com os nomes concretos (PR #388, migração 0056, a pergunta em si).

Responda só com JSON: {"pendencias": ["..."]} — lista vazia se não houver nada.

<resposta>
${fim}
</resposta>`,
  })
  if (!r.isAnswered) return null
  const json = /\{[\s\S]*\}/.exec(r.text)?.[0]
  if (!json) return null
  try {
    const lista = (JSON.parse(json) as { pendencias?: unknown }).pendencias
    return Array.isArray(lista)
      ? lista.map(x => String(x).trim().slice(0, 140)).filter(Boolean).slice(0, 6)
      : null
  } catch {
    return null
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const sessao = await $.session.id()
    await update($, sessaoAtual, () => sessao)
    await recarregar($)

    await $.command.register({
      name: 'pendencias',
      description: 'Abre a caixa de pendências; com texto, anota uma pendência nova',
      argumentHint: '[texto]',
    })
    await $.tool.register({
      name: 'pendencia_registrar',
      description:
        'Anota na caixa de pendências do usuário algo que depende dele e deve sobreviver a esta sessão (aprovar, aplicar, decidir). As perguntas do fim das suas respostas já entram sozinhas; use isto para o que precisa ficar registrado mesmo depois.',
      inputSchema: {
        type: 'object',
        properties: { texto: { type: 'string', description: 'Imperativo curto, com nomes concretos' } },
        required: ['texto'],
      },
    })
    await $.tool.register({
      name: 'pendencia_resolver',
      description:
        'Marca como resolvida uma pendência da caixa do usuário quando ele disser que já fez (por exemplo, aplicou a migração ou fez o merge). Passe um trecho do texto da pendência.',
      inputSchema: {
        type: 'object',
        properties: { trecho: { type: 'string' } },
        required: ['trecho'],
      },
    })

    const projeto = await projetoAtual($)
    const deOutras = abertas(await read($, itens)).filter(x => x.sessao !== sessao)
    if (deOutras.length > 0) {
      $.ui.toast(`${deOutras.length} pendência(s) de outras sessões`)
      if (e.surface === 'mobile') void $.ui.open({ id: PANE, title: TITULO })
      const daqui = deOutras.filter(x => x.projeto === projeto)
      if (daqui.length > 0) {
        await update($, contexto, () =>
          `# Pendências do usuário neste projeto\n\nDe sessões anteriores, ainda abertas na caixa de pendências dele:\n${daqui
            .map(x => `- ${x.texto}`)
            .join('\n')}\n\nSe o usuário disser que resolveu alguma, marque com pendencia_resolver.`,
        )
      }
    }

    return started
  })

  on('command.run', { command: 'pendencias' }, async ($, e) => {
    const texto = e.args.trim()
    if (texto) {
      const agora = await $.clock.now()
      const pendencia: Pendencia = {
        id: `m${agora}`,
        texto: texto.slice(0, 140),
        projeto: await projetoAtual($),
        sessao: await read($, sessaoAtual),
        origem: 'manual',
        criadaEm: agora,
      }
      await salvar($, l => [...l, pendencia])
    } else {
      await recarregar($)
    }
    await $.ui.open({ id: PANE, title: TITULO })

    return { text: texto ? `Anotado: ${texto}` : 'Caixa de pendências aberta.' }
  })

  on('tool.call', { tool: 'mcp__pendencias__pendencia_registrar' }, async ($, e) => {
    const texto = String(e.texto ?? '').trim().slice(0, 140)
    if (!texto) return { deny: 'texto vazio' }
    const agora = await $.clock.now()
    const pendencia: Pendencia = {
      id: `m${agora}`,
      texto,
      projeto: await projetoAtual($),
      sessao: await read($, sessaoAtual),
      origem: 'manual',
      criadaEm: agora,
    }
    await salvar($, l => [...l, pendencia])

    return { result: `Pendência anotada: ${texto}` }
  })

  on('tool.call', { tool: 'mcp__pendencias__pendencia_resolver' }, async ($, e) => {
    const trecho = String(e.trecho ?? '').trim().toLowerCase()
    if (!trecho) return { deny: 'trecho vazio' }
    const agora = await $.clock.now()
    let achadas: string[] = []
    await salvar($, l => {
      achadas = abertas(l)
        .filter(x => x.texto.toLowerCase().includes(trecho))
        .map(x => x.id)
      return l.map(x => (achadas.includes(x.id) ? { ...x, resolvidaEm: agora } : x))
    })

    return achadas.length > 0
      ? { result: `${achadas.length} pendência(s) resolvida(s).` }
      : { deny: `Nenhuma pendência aberta com "${trecho}".` }
  })

  // Cada turno respondido substitui as pendências automáticas desta sessão:
  // se a pessoa respondeu, o pedido anterior não vale mais; se o turno pede
  // algo de novo, entra a lista nova.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.reason !== 'answer' || e.agentId) return ran

    void (async () => {
      const lista = await extrair($, e.answer)
      if (lista === null) return
      const sessao = await read($, sessaoAtual)
      const projeto = await projetoAtual($)
      const agora = await $.clock.now()
      const novas: Pendencia[] = lista.map((texto, i) => ({
        id: `a${agora}-${i}`,
        texto,
        projeto,
        sessao,
        origem: 'auto',
        criadaEm: agora,
      }))
      await salvar($, l => [
        ...l.filter(x => !(x.origem === 'auto' && x.sessao === sessao && !x.resolvidaEm)),
        ...novas,
      ])
    })().catch(() => undefined)

    return ran
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const texto = await read($, contexto)
    if (!texto) return r

    return { ...r, sections: [...r.sections, { id: 'pendencias:abertas', scope: 'session' as const, text: texto }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const abaixo = await next(e)
    if (e.props.hasSurvey || (await read($, faixaOculta))) return abaixo
    const sessao = await read($, sessaoAtual)
    const deOutras = abertas(await read($, itens)).filter(x => x.sessao !== sessao)
    if (deOutras.length === 0) return abaixo

    const { Box, Text, Button } = $.ui.resolve(e)
    const primeira = deOutras[deOutras.length - 1]!

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor>
            {deOutras.length} pendência(s) de outras sessões · {primeira.projeto}: {primeira.texto}
          </Text>
          <Button key="ver" label="Ver" onPress={() => $.ui.open({ id: PANE, title: TITULO })} />
          <Button key="ocultar" label="Ocultar" role="dismiss" onPress={() => update($, faixaOculta, () => true)} />
        </Box>
        {abaixo}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const lista = await read($, itens)
    const sessao = await read($, sessaoAtual)
    const agora = await $.clock.now()
    const pendentes = abertas(lista).reverse()
    const resolvidas = lista.filter(x => x.resolvidaEm)

    const resolver = (id: string) => async () => {
      const quando = await $.clock.now()
      await salvar($, l => l.map(x => (x.id === id ? { ...x, resolvidaEm: quando } : x)))
    }
    const limpar = () => salvar($, l => l.filter(x => !x.resolvidaEm))

    if (pendentes.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Nada esperando você.</Text>
          <Text dimColor>O que o Claude pedir no fim de uma resposta aparece aqui; /pendencias &lt;texto&gt; anota à mão.</Text>
        </Box>
      )
    }

    const projetos = [...new Set(pendentes.map(x => x.projeto))]

    return (
      <Box flexDirection="column">
        {projetos.map(projeto => (
          <Box key={`p-${projeto}`} flexDirection="column" marginBottom={1}>
            <Text weight="semibold">{projeto}</Text>
            {pendentes
              .filter(x => x.projeto === projeto)
              .map(x => (
                <Box key={`i-${x.id}`} flexDirection="column">
                  <Text>• {x.texto}</Text>
                  <Box flexDirection="row" gap={1}>
                    <Text dimColor>
                      {x.sessao === sessao ? 'esta sessão' : 'outra sessão'} · há {idade(agora - x.criadaEm)}
                    </Text>
                    <Button key={`r-${x.id}`} label="Feito" onPress={resolver(x.id)} />
                  </Box>
                </Box>
              ))}
          </Box>
        ))}
        {resolvidas.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{resolvidas.length} resolvida(s) na última semana</Text>
            <Button key="limpar" label="Limpar" onPress={limpar} />
          </Box>
        )}
      </Box>
    )
  })
}
