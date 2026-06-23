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

O botão consulta o Worker
`https://flipcerto-odds.igordangelo.workers.dev/odds` antes de gerar mercados.
O Worker mantém a chave da [The Odds API](https://the-odds-api.com/) em segredo,
remove a margem das casas e compartilha um cache de 3 horas entre todos os
usuários. Se as odds falharem, o site usa automaticamente Poisson e força
relativa.
