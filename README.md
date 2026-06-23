# FlipCerto Agent

Curador de mercados esportivos de curto prazo para a FlipCerto.

## Automação

O workflow `Refresh market intelligence` roda:

- a cada push na `main`;
- manualmente pelo GitHub Actions;
- automaticamente a cada 4 horas.

Ele busca o calendário oficial da FIFA, preserva os dados anteriores se a
fonte falhar, recalcula a inteligência das partidas e publica o GitHub Pages.

## Odds de bookmakers

O pipeline funciona sem chave usando Poisson e força relativa. Para ativar
consenso de bookmakers, adicione no repositório:

`Settings → Secrets and variables → Actions → New repository secret`

Nome: `ODDS_API_KEY`

Valor: chave da [The Odds API](https://the-odds-api.com/).

A chave fica somente no GitHub Actions e nunca é enviada ao navegador.
