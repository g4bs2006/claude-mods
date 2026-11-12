import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entrega, StatusEntrega } from '../types'

const PANE = 'sol'
const TITULO_PANE = 'Sol: delegações'
const CHAVE_STORE = 'entregas'
const LIMITE = 40

// Troque a etiqueta quando os campos de Entrega mudarem: o que uma versão
// anterior guardou é lido como lista vazia em vez de quebrar o desenho.
const entregas = atom(
  { plugin: 'sol-delegacoes', key: 'entregas' } as const,
  [] as Entrega[],
  { shape: 'entregas-1' },
)

// node scripts/sol.mjs <tarefa.md> <pasta> [contexto...]
const CHAMADA = /scripts\/sol\.mjs\s+("[^"]+"|'[^']+'|\S+)\s+("[^"]+"|'[^']+'|\S+)/
const RESUMO = /(\d+) arquivo\(s\) em (\d+)s · tokens: entrada (\S+), saída (\S+)/
const FALHAS = /A OpenAI recusou|Defina OPENAI_API_KEY|Uso: node scripts\/sol\.mjs|Recusado: |Resposta sem texto/

const REVISADAS: StatusEntrega[] = ['aceita', 'ajustada', 'recusada']

const semAspas = (s: string) => s.replace(/^["']|["']$/g, '')
const absoluto = (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`)

const ROTULO: Record<StatusEntrega, string> = {
  rodando: 'rodando',
  entregue: 'esperando revisão',
  falhou: 'falhou',
  aceita: 'aceita',
  ajustada: 'aceita com ajustes',
  recusada: 'recusada',
}

async function salvar($: EngineInterface, fn: (lista: Entrega[]) => Entrega[]) {
  const nova = await update($, entregas, lista => fn(lista ?? []).slice(-LIMITE))
  await $.store.set(CHAVE_STORE, nova)
}

async function tituloDaTarefa($: EngineInterface, caminho: string) {
  try {
    const texto = await $.fs.read(caminho)
    const linha = String(texto)
      .split('\n')
      .find(l => l.trim().length > 0)
    return linha ? linha.replace(/^#+\s*/, '').trim().slice(0, 90) : caminho
  } catch {
    return caminho
  }
}

async function lerNotas($: EngineInterface, entrega: Entrega) {
  try {
    const texto = await $.fs.read(`${absoluto(entrega.cwd, entrega.pasta)}/_notas-do-sol.md`)
    return String(texto).trim().slice(0, 600)
  } catch {
    return undefined
  }
}

// Uma delegação rodada em segundo plano não devolve a saída no tool.call:
// ela conta como entregue quando o _notas-do-sol.md aparece na pasta.
async function conferirRodando($: EngineInterface) {
  const lista = await read($, entregas)
  for (const entrega of lista.filter(x => x.status === 'rodando')) {
    const notas = await lerNotas($, entrega)
    if (notas === undefined) continue
    let arquivos: string[] = []
    try {
      const pasta = absoluto(entrega.cwd, entrega.pasta)
      arquivos = (await $.fs.list(pasta))
        .filter(f => f.name !== '_notas-do-sol.md')
        .map(f => f.name)
    } catch {
      // a pasta sumiu entre a leitura e a listagem: fica sem a lista
    }
    const fim = await $.clock.now()
    await salvar($, l =>
      l.map(x =>
        x.id === entrega.id ? { ...x, status: 'entregue', notas, arquivos, fim } : x,
      ),
    )
  }
}

function acharEntrega(lista: Entrega[], ref: string) {
  const alvo = ref.replace(/\/+$/, '')
  return [...lista]
    .reverse()
    .find(x => x.id === alvo || x.pasta.replace(/\/+$/, '') === alvo || x.tarefa === alvo)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // $.state vive na sessão; o $.store guarda entre sessões.
    const guardadas = (await $.store.get(CHAVE_STORE)) as Entrega[] | undefined
    const atuais = await read($, entregas)
    if (atuais.length === 0 && Array.isArray(guardadas) && guardadas.length > 0) {
      await update($, entregas, () => guardadas)
    }

    await $.command.register({
      name: 'sol',
      description: 'Abre o painel das tarefas delegadas ao Sol',
    })
    await $.tool.register({
      name: 'sol_revisao',
      description:
        'Registra o resultado da revisão de uma entrega do Sol (scripts/sol.mjs) no painel de delegações. Chame depois de revisar a pasta de rascunho: aceita (entrou sem ajustes), ajustada (entrou com correções suas) ou recusada.',
      inputSchema: {
        type: 'object',
        properties: {
          pasta: {
            type: 'string',
            description: 'A pasta de rascunho passada ao sol.mjs (ou o arquivo da tarefa)',
          },
          resultado: { type: 'string', enum: ['aceita', 'ajustada', 'recusada'] },
          nota: {
            type: 'string',
            description: 'Uma ou duas linhas: o que foi ajustado ou por que foi recusada',
          },
        },
        required: ['pasta', 'resultado'],
      },
      isDeferred: false,
    })

    await conferirRodando($)
    const lista = await read($, entregas)
    const pendentes = lista.filter(x => x.status === 'entregue' || x.status === 'rodando')
    if (pendentes.length > 0) {
      $.ui.toast(`Sol: ${pendentes.length} entrega(s) esperando você`)
      if (e.surface !== 'terminal') void $.ui.open({ id: PANE, title: TITULO_PANE })
    }

    return started
  })

  on('command.run', { command: 'sol' }, async $ => {
    await conferirRodando($)
    await $.ui.open({ id: PANE, title: TITULO_PANE })

    return { text: 'Painel do Sol aberto.' }
  })

  on('tool.call', { tool: 'mcp__sol-delegacoes__sol_revisao' }, async ($, e) => {
    const pasta = String(e.pasta ?? '')
    const resultado = String(e.resultado ?? '') as StatusEntrega
    const nota = typeof e.nota === 'string' ? e.nota.slice(0, 400) : undefined
    if (!REVISADAS.includes(resultado)) {
      return { deny: 'resultado deve ser aceita, ajustada ou recusada' }
    }
    const lista = await read($, entregas)
    const entrega = acharEntrega(lista, pasta)
    if (!entrega) {
      return { deny: `Nenhuma delegação com a pasta ${pasta} no painel.` }
    }
    await salvar($, l =>
      l.map(x => (x.id === entrega.id ? { ...x, status: resultado, revisao: nota } : x)),
    )

    return { result: `Entrega "${entrega.titulo}" marcada como ${ROTULO[resultado]}.` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const achado = CHAMADA.exec(e.command)
    if (!achado) return next(e)

    const cwd = (await $.process.run(['pwd']).catch(() => null))?.stdout.trim() || '.'
    const tarefa = semAspas(achado[1] ?? '')
    const pasta = semAspas(achado[2] ?? '')
    const inicio = await $.clock.now()
    const entrega: Entrega = {
      id: `${inicio}`,
      titulo: await tituloDaTarefa($, absoluto(cwd, tarefa)),
      tarefa,
      pasta,
      cwd,
      inicio,
      status: 'rodando',
    }
    await salvar($, l => [...l, entrega])
    $.ui.status(`Sol trabalhando: ${entrega.titulo}`)

    const ran = await next(e)
    $.ui.status(undefined)

    if (e.run_in_background) return ran

    const saida = ran.text ?? ''
    const fim = await $.clock.now()
    const resumo = RESUMO.exec(saida)
    const falhou = ran.deny !== undefined || ran.isError === true || FALHAS.test(saida) || !resumo
    const mudanca: Partial<Entrega> = falhou
      ? {
          status: 'falhou',
          fim,
          erro: (ran.deny ?? saida).trim().split('\n').slice(-3).join(' ').slice(0, 300),
        }
      : {
          status: 'entregue',
          fim,
          arquivos: [...saida.matchAll(/^gravado (.+)$/gm)].map(m => (m[1] ?? '').trim()),
          segundos: Number(resumo![2] ?? 0),
          tokensEntrada: resumo![3],
          tokensSaida: resumo![4],
          notas: (saida.split('Notas do Sol:\n')[1] ?? '').trim().slice(0, 600) || undefined,
        }
    await salvar($, l => l.map(x => (x.id === entrega.id ? { ...x, ...mudanca } : x)))
    $.ui.toast(
      falhou
        ? `Sol: a delegação "${entrega.titulo}" falhou`
        : `Sol entregou "${entrega.titulo}": esperando revisão`,
    )

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await conferirRodando($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const lista = [...(await read($, entregas))].reverse()

    const marcar = (id: string, status: StatusEntrega) => () =>
      salvar($, l => l.map(x => (x.id === id ? { ...x, status } : x)))
    const limpar = () => salvar($, l => l.filter(x => !REVISADAS.includes(x.status)))

    if (lista.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Nenhuma tarefa delegada ao Sol ainda.</Text>
          <Text dimColor>Elas aparecem aqui quando o scripts/sol.mjs roda.</Text>
        </Box>
      )
    }

    const abertas = lista.filter(x => !REVISADAS.includes(x.status))
    const revisadas = lista.filter(x => REVISADAS.includes(x.status))

    const cartao = (x: Entrega) => (
      <Box key={`e-${x.id}`} flexDirection="column" marginBottom={1}>
        <Text weight="semibold">{x.titulo}</Text>
        <Text dimColor>
          {ROTULO[x.status]}
          {x.arquivos ? ` · ${x.arquivos.length} arquivo(s)` : ''}
          {x.segundos !== undefined ? ` · ${x.segundos}s` : ''}
          {x.tokensSaida ? ` · saída ${x.tokensSaida} tokens` : ''}
        </Text>
        <Text dimColor>rascunho: {x.pasta}</Text>
        {x.arquivos && x.arquivos.length > 0 && (
          <Text dimColor>
            {x.arquivos.slice(0, 6).join(', ')}
            {x.arquivos.length > 6 ? ` e mais ${x.arquivos.length - 6}` : ''}
          </Text>
        )}
        {x.status === 'entregue' && x.notas && <Text>{x.notas.slice(0, 280)}</Text>}
        {x.erro && <Text dimColor>erro: {x.erro}</Text>}
        {x.revisao && <Text dimColor>revisão: {x.revisao}</Text>}
        {x.status === 'entregue' && (
          <Box flexDirection="row" gap={1}>
            <Button key={`a-${x.id}`} label="Aceita" variant="primary" onPress={marcar(x.id, 'aceita')} />
            <Button key={`j-${x.id}`} label="Com ajustes" onPress={marcar(x.id, 'ajustada')} />
            <Button key={`r-${x.id}`} label="Recusada" onPress={marcar(x.id, 'recusada')} />
          </Box>
        )}
        {x.status === 'falhou' && (
          <Button key={`d-${x.id}`} label="Descartar" onPress={marcar(x.id, 'recusada')} />
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {abertas.length > 0 ? abertas.map(cartao) : <Text dimColor>Nada esperando revisão.</Text>}
        {revisadas.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Revisadas ({revisadas.length})</Text>
            {revisadas.slice(0, 8).map(x => (
              <Text key={`v-${x.id}`} dimColor>
                {ROTULO[x.status]}: {x.titulo}
              </Text>
            ))}
            <Button key="limpar" label="Limpar revisadas" onPress={limpar} />
          </Box>
        )}
      </Box>
    )
  })
}
