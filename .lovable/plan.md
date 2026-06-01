## Refatoração do Caixa do Dia

Objetivo: separar claramente `cash_movements` (dinheiro) de `daily_events` (linha do tempo) e tornar `daily_cash` o resumo oficial do dia por trabalhador.

### 1. Migration — `daily_cash`

Adicionar colunas que faltam (sem apagar dados):
- `opening_balance numeric default 0`
- `total_in numeric default 0`
- `total_out numeric default 0`
- `total_lent numeric default 0`
- `total_manual_in numeric default 0`
- `total_manual_out numeric default 0`
- `total_events_count integer default 0`
- `expected_closing_balance numeric default 0`
- `closed_by uuid`
- `reopened_at timestamptz`, `reopened_by uuid`, `reopen_reason text`

Adicionar RPC `close_daily_cash(p_cash_date date)` que:
- valida que não está fechado
- calcula totais a partir de `daily_events` não estornados do worker/admin atual
- grava em `daily_cash`
- registra `audit_log`

Adicionar RPC `reopen_daily_cash(p_cash_date date, p_reason text)`:
- exige motivo
- volta status para `open`
- registra `audit_log`

### 2. Camada de eventos (`src/lib/daily-events.ts`)

Estender `DailyEventType` com os tipos operacionais novos:
`renegociacao`, `cliente_criado`, `cliente_editado`, `parcela_editada`, `transferencia_cliente`, `anexo_adicionado`, `anexo_removido`.

Eventos sem dinheiro: `amount_in=0`, `amount_out=0`, `cash_movement_id=null`.

Adicionar helper `isFinancialEvent(type)` e usar em `getDailyEvents` para particionar a timeline em 3 grupos (financeiro / operacional / estorno).

### 3. Pontos de criação de eventos

- `payment-utils.ts`: pagamento e estorno já corretos — apenas garantir `worker_id/admin_id`.
- `LoanDetailPage.tsx`: renegociação → trocar `event_type` de `renovacao` para `renegociacao` (renovação continua `renovacao`).
- `ClientForm.tsx` / `ClientsPage.tsx`: criar/editar cliente → `cliente_criado` / `cliente_editado` (sem dinheiro).
- `TransferClientDialog.tsx`: `transferencia_cliente`.
- `ClientAttachments.tsx`: `anexo_adicionado` / `anexo_removido`.
- Edição de parcela (`LoanDetailPage`): `parcela_editada`.
- Não criar `cash_movement` para nenhum desses.

### 4. `CaixaPage.tsx`

Reorganizar (sem mudar tema/cores):
- **Cabeçalho**: data + status do caixa (aberto/fechado) + saldo final esperado.
- **Resumo**: cards compactos com saldo inicial, entradas, saídas, recebido pagamentos, multas, empréstimos liberados, entradas manuais, saídas manuais, saldo final esperado, qtde "não pagou", total de atividades.
- **Timeline** abaixo, em 3 seções:
  1. Movimentos financeiros
  2. Atividades sem dinheiro
  3. Estornos/correções (collapsível, mostra eventos com `reversed_at`)

Fechar caixa → chama RPC `close_daily_cash`. Reabrir → dialog de motivo → RPC `reopen_daily_cash`.

Bloquear botões financeiros (entrada/saída/ajuste manual) quando `status='closed'` via `assertCashOpen`.

### 5. `DailyCashHistoryPage.tsx` e `DailyReportPage.tsx`

Ler totais direto de `daily_cash` (não recalcular client-side). Usar os mesmos labels de `getEventTypeLabel`. Incluir `renegociacao` na lista.

### 6. Validação

- `tsc --noEmit` via build.
- Smoke test mental: pagamento gera 1 movement + 1 event; criar cliente gera só 1 event sem dinheiro; renegociação aparece como `renegociacao`; fechar caixa preenche todos os totais; reabrir exige motivo.

### Arquivos

**Migration nova:** `supabase/migrations/<ts>_daily_cash_totals.sql`

**Editar:**
- `src/lib/daily-events.ts` (novos tipos + helper)
- `src/pages/CaixaPage.tsx` (resumo + timeline + fechar/reabrir)
- `src/pages/LoanDetailPage.tsx` (event_type `renegociacao`)
- `src/pages/DailyCashHistoryPage.tsx`
- `src/pages/DailyReportPage.tsx`
- `src/components/ClientForm.tsx`, `src/pages/ClientsPage.tsx`, `src/pages/ClientDetailPage.tsx`
- `src/components/TransferClientDialog.tsx`
- `src/components/ClientAttachments.tsx`
