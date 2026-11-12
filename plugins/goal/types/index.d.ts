export type StatusEtapa = 'pendente' | 'andamento' | 'feita'

export type Etapa = {
  id: string
  titulo: string
  status: StatusEtapa
  feitaEm?: number
}

export type Goal = {
  texto: string
  repo: string
  criadoEm: number
  concluidoEm?: number
  etapas: Etapa[]
  commits: number
  ultimoCommit?: string
}

declare module 'claude-code' {
  interface PluginState {
    goal: { atual: Shaped<Goal | null> }
  }
}
