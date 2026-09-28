# AGENTS.md

## Regras

- `daily_events.observation` é texto descritivo exibido ao operador; nunca é fonte de valores. Todo valor financeiro de tela vem dos campos numéricos de `daily_events.metadata`, convertido com `Number()` e aceito apenas se finito e não negativo — o texto do banco usa formato "325.00" e relê-lo como número brasileiro viraria 32500.
