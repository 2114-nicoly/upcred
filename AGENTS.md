# AGENTS.md

## Regras

- `daily_events.observation` é texto descritivo exibido ao operador; nunca é fonte de valores. Todo valor financeiro de tela vem dos campos numéricos de `daily_events.metadata`, convertido com `Number()` e aceito apenas se finito e não negativo — o texto do banco usa formato "325.00" e relê-lo como número brasileiro viraria 32500.
- Todo registro de ação exibido em qualquer tela passa por `normalizeEvent` (src/lib/event-record.ts), que lê só `daily_events.metadata`/linhas congeladas — assim nomes, valores e significados ficam iguais em todas as telas e o histórico nunca é reconstruído pelo estado atual.
- Quitação (`settleLoan`) usa `register_payment_tx` com origem "quitacao" — mesma atomicidade e metadata do pagamento normal.
