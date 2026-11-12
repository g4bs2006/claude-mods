export type Ultimo = {
  resposta: string
  quando: number
  branch: string
}

export type Resumo = {
  repo: string
  nome: string
  branch: string
  commits: { hash: string; assunto: string; quando: string }[]
  naoCommitados: string[]
  adiante: number | null
  atras: number | null
  doc?: { arquivo: string; quando: string }
  ultimo?: Ultimo
  montadoEm: number
}

declare module 'claude-code' {
  interface PluginState {
    retomada: {
      resumo: Shaped<Resumo | null>
      faixaVisivel: boolean
      contexto: string
    }
  }
}
