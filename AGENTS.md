# AGENTS.md

## Regras

- Renewal affordability uses the locked current cash balance plus actual renewal receipts minus released cash; defer movement synchronization until the transaction is complete and skip redundant balance writes so historical daily balances never decide affordability.

- Renewal interest-only previews stay local to NewLoanPage and use the existing interest-first allocation from loan totals and remaining balance; imported loans with conflicting accounting bases show unavailable rather than guessing, while renew_loan_tx remains the only writer.

- Administrative navigation reuses existing detail routes and access components; global cash links and scoped shortcuts remain distinct because scoped navigation must retain its confirmation and worker/company filters.

- Editable money uses `MoneyInput` and the `money-input` parser/formatter; keep raw text while focused and format on blur to preserve the caret, never parse ledger metadata through the text-input parser.

- `daily_events.observation` é texto descritivo exibido ao operador; nunca é fonte de valores. Todo valor financeiro de tela vem dos campos numéricos de `daily_events.metadata`, convertido com `Number()` e aceito apenas se finito e não negativo — o texto do banco usa formato "325.00" e relê-lo como número brasileiro viraria 32500.
- Todo registro de ação exibido em qualquer tela passa por `normalizeEvent` (src/lib/event-record.ts), que lê só `daily_events.metadata`/linhas congeladas — assim nomes, valores e significados ficam iguais em todas as telas e o histórico nunca é reconstruído pelo estado atual.
- Quitação (`settleLoan`) usa `register_payment_tx` com origem "quitacao" — mesma atomicidade e metadata do pagamento normal.

- Client search updates local input state immediately and persists `q` on blur; route identity excludes only `/clients`'s `q` parameter so URL persistence never remounts the search or its dialogs.
