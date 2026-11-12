export type Pendencia = {
  id: string
  texto: string
  projeto: string
  sessao: string
  origem: 'auto' | 'manual'
  criadaEm: number
  resolvidaEm?: number
}

declare module 'claude-code' {
  interface PluginState {
    pendencias: {
      itens: Shaped<Pendencia[]>
      sessao: string
      faixaOculta: boolean
      contexto: string
    }
  }
}
