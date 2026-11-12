export type FaseProposta =
  | 'gerando'
  | 'pronta'
  | 'commitando'
  | 'enviando'
  | 'feito'
  | 'erro'

export type Proposta = {
  cwd: string
  branch: string
  assinatura: string
  arquivos: string[]
  mensagem: string
  fase: FaseProposta
  detalhe?: string
}

declare module 'claude-code' {
  interface PluginState {
    'commit-por-etapa': {
      proposta: Shaped<Proposta | null>
      dispensada: string
    }
  }
}
