export type StatusEntrega =
  | 'rodando'
  | 'entregue'
  | 'falhou'
  | 'aceita'
  | 'ajustada'
  | 'recusada'

export type Entrega = {
  id: string
  titulo: string
  tarefa: string
  pasta: string
  cwd: string
  inicio: number
  fim?: number
  status: StatusEntrega
  arquivos?: string[]
  segundos?: number
  tokensEntrada?: string
  tokensSaida?: string
  notas?: string
  erro?: string
  revisao?: string
}

declare module 'claude-code' {
  interface PluginState {
    'sol-delegacoes': { entregas: Shaped<Entrega[]> }
  }
}
