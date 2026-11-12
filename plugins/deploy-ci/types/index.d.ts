export type EstadoCheck = 'pendente' | 'ok' | 'falhou' | 'neutro'

export type Check = {
  nome: string
  estado: EstadoCheck
  url?: string
}

export type FaseVigia = 'vigiando' | 'verde' | 'falhou' | 'sem-checks' | 'sem-acesso' | 'tempo'

export type Vigia = {
  sha: string
  curto: string
  branch: string
  repo: string
  cwd: string
  inicio: number
  fase: FaseVigia
  checks: Check[]
  detalhe?: string
}

declare module 'claude-code' {
  interface PluginState {
    'deploy-ci': {
      vigia: Shaped<Vigia | null>
      oculto: boolean
    }
  }
}
