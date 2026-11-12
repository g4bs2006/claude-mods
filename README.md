# claude-mods

Mods do Claude Code para o meu fluxo de trabalho: acompanhar o goal da sessão, não perder o que depende de mim entre sessões, retomar de onde parei, acompanhar deploy e CI, revisar o que foi delegado ao Sol e commitar cada etapa.

| Mod | O que faz | Comando |
| --- | --- | --- |
| `goal` | Painel com o objetivo da sessão, as etapas (espelhadas das tasks do Claude), o progresso e os commits desde o início. Guardado por repositório: a próxima sessão continua de onde parou. | `/meta [objetivo]` |
| `pendencias` | Ao fim de cada resposta que pede algo a você (aprovar, responder, rodar, fazer merge), anota numa caixa compartilhada entre sessões. Faixa com as pendências de outras sessões e botão "Feito". | `/pendencias [texto]` |
| `retomada` | Ao abrir a sessão: branch, o que não foi commitado nem enviado, últimos commits, doc mais recente e o fim da última resposta naquele repositório. O Claude recebe o mesmo resumo. | `/retomada` |
| `deploy-ci` | Depois de cada push, acompanha os checks e os status do GitHub (Vercel incluída) do commit e notifica quando fica verde ou falha. Precisa do `gh` autenticado ou de `GH_TOKEN`. | `/deploy` |
| `sol-delegacoes` | Painel das tarefas mandadas ao Sol por `scripts/sol.mjs`: rodando, entregue, falhou, e a revisão (aceita, com ajustes, recusada). | `/sol` |
| `commit-por-etapa` | No fim de cada turno com mudanças, propõe a mensagem de commit no estilo dos commits anteriores e envia para a branch atual (nunca `main`/`master`; recusa `.env`). | `/commit-etapa [mensagem]` |

Cada mod tem painel, que aparece também no app do celular; no terminal e no desktop alguns mostram uma faixa acima do prompt.

## Instalar

O repositório é privado: a máquina precisa ter uma credencial do GitHub para `github.com` (uma chave SSH, ou `gh auth login` e depois `gh auth setup-git`). A instalação não pede senha.

No prompt de uma sessão do Claude Code no terminal, um mod por vez:

```
/plugin install goal --marketplace g4bs2006/claude-mods
/plugin install pendencias --marketplace g4bs2006/claude-mods
/plugin install retomada --marketplace g4bs2006/claude-mods
/plugin install deploy-ci --marketplace g4bs2006/claude-mods
/plugin install sol-delegacoes --marketplace g4bs2006/claude-mods
/plugin install commit-por-etapa --marketplace g4bs2006/claude-mods
```

Na primeira, responda `y` para adicionar o marketplace e escolha o escopo (usuário, para valer em todas as sessões).

De um shell:

```
claude plugin install goal --marketplace g4bs2006/claude-mods
```

No app desktop, onde `/plugin` não roda: clique em + ao lado da caixa do prompt, depois em Plugins, Add marketplace com `g4bs2006/claude-mods`, e Add plugin.

## Desenvolver

Cada mod é uma pasta em `plugins/` com `.claude-plugin/plugin.json`, `hooks/register.tsx` e o contrato de estado em `types/index.d.ts`. Para rodar uma cópia local sem instalar: `claude --plugin-dir plugins/<mod>`. Testes: `claude plugin test plugins/<mod>`; validação: `claude plugin validate plugins/<mod>`.
