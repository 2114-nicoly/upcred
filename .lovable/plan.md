# Plano: 4 melhorias estruturais no UpCred

Trabalho dividido em 4 frentes. Sem mudanças visuais. Reaproveita funções/tabelas existentes (`audit_logs`, `log_audit`, `daily_cash`, `daily_events`, `loan_renegotiations`, `loans`, `installments`).

---

## 1. Auditoria completa

Criar helper centralizado `src/lib/audit-log.ts` (ou estender `audit-utils.ts`) com `logAudit({ action, entity, entityId, oldValue, newValue, observation, workerId })` que chama a RPC `log_audit` já existente (ela preenche user_id/worker_id/admin_id automaticamente).

Pontos de chamada a auditar (inserir 1 linha em cada handler):
- Clientes: criação (`ClientForm`), edição, exclusão.
- Empréstimos: criação (`NewLoanPage`), renovação, cancelamento, quitação, edição de parcelas.
- Pagamentos: `registerPayment` e `reversePayment` em `payment-utils.ts`.
- "Não pagou": insert/undo em `DailyCashPage`.
- Caixa: fechar/reabrir em `DailyCashPage` e ajustes manuais em `CaixaPage`/`Geral`.
- Renegociação: novo fluxo (item 4).

Action types padrão: `criar_cliente`, `editar_cliente`, `excluir_cliente`, `criar_emprestimo`, `renovar_emprestimo`, `renegociar_emprestimo`, `cancelar_emprestimo`, `quitar_emprestimo`, `pagamento`, `nao_pagou`, `estorno_pagamento`, `desfazer_nao_pagou`, `fechar_caixa`, `reabrir_caixa`, `entrada_manual`, `saida_manual`, `ajuste_caixa`.

## 2. Bloqueio com caixa fechado

Migração: criar função SQL `is_cash_closed(p_worker_id uuid, p_admin_id uuid, p_date date) returns boolean` que consulta `daily_cash` pelo escopo correto.

Criar helper `src/lib/cash-lock.ts` com `assertCashOpen(date, workerId?)` que faz SELECT em `daily_cash` filtrado por worker/admin escopo e lança erro "Caixa do dia já está fechado. Reabra antes de operar." se status=`closed`.

Chamar `assertCashOpen` no início dos handlers em:
- `DailyCashPage`: handlePay, handleNotPaid, handleBatchNotPaid, handleUndo.
- `CaixaPage`/módulo Geral: entrada/saída/ajuste manual.
- `NewLoanPage`: validar `loan_date` antes de submit (apenas se igual ao caixa fechado).
- `LoanDetailPage`: pagamento, cancelamento, renovação.

Admin/superadmin continuam podendo reabrir via botão existente.

## 3. Padronizar status

Criar `src/lib/status-constants.ts`:
```ts
export const LOAN_STATUS = { OPEN:'open', PAID:'paid', OVERDUE:'overdue', CANCELLED:'cancelled', RENEGOTIATED:'renegotiated' } as const;
export const INSTALLMENT_STATUS = { PENDING:'pending', PARTIAL:'partial', PAID:'paid', OVERDUE:'overdue', CANCELLED:'cancelled', RENEGOTIATED:'renegotiated' } as const;
```

Atualizar `getStatusLabel`/`getStatusColor` em `loan-utils.ts` para cobrir `cancelled` e `renegotiated` (cinza neutro, sem alterar paleta — usa `bg-muted`).

Revisar `admin_recalculate_loans` e `admin_recalculate_installments` (migração) para ignorar empréstimos com status `cancelled` ou `renegotiated` (não recalcular para overdue).

Telas: `ActiveLoansPage`, `LoanDetailPage`, `OverdueLoansPage` — filtrar `status NOT IN ('cancelled','renegotiated')` onde mostram "ativos".

## 4. Renegociação completa

Reaproveitar tabela existente `loan_renegotiations` (já tem todos os campos: original_loan_id, new_loan_id, original_*, new_*, type, reason).

Criar página/dialog `RenegotiateLoanDialog` (estilo igual ao renovar — sem novo design). Campos: novo valor, juros, parcelas, frequência, primeira data, motivo.

Fluxo no submit (transação client-side, com rollback manual em caso de erro):
1. `assertCashOpen` (item 2).
2. INSERT `loans` novo com `renewed_from_loan_id = original` e status `open`.
3. Gerar `installments` do novo.
4. UPDATE original: `status = 'renegotiated'`, `remaining_balance = 0`.
5. UPDATE installments do original com `status IN ('pending','partial','overdue')` → `status = 'renegotiated'`.
6. INSERT `loan_renegotiations` com snapshot original_* e new_*, type='renegociacao', reason, worker_id, admin_id.
7. `createDailyEvent` event_type='renegociacao' (entrada/saída líquida conforme valor liberado vs absorvido — espelhar lógica de renovação existente).
8. `logAudit('renegociar_emprestimo', 'loan', originalId, {original}, {newLoanId}, motivo)`.

Disponibilizar botão "Renegociar" em `LoanDetailPage` ao lado de "Renovar" (mesmo estilo de botão existente).

Incluir renegociação na exibição de `DailyReportPage` e `DailyCashHistoryPage` — já listam `daily_events`, basta tratar o tipo `renegociacao` no mapeamento de label.

---

## Arquivos a criar
- `src/lib/audit-log.ts` (helper)
- `src/lib/cash-lock.ts` (helper)
- `src/lib/status-constants.ts`
- `src/components/RenegotiateLoanDialog.tsx`
- 1 migração: função `is_cash_closed` + ajuste em `admin_recalculate_*` para ignorar cancelled/renegotiated.

## Arquivos a editar (handlers)
- `src/lib/payment-utils.ts`, `src/lib/daily-events.ts`
- `src/pages/DailyCashPage.tsx`, `src/pages/CaixaPage.tsx`, `src/pages/NewLoanPage.tsx`, `src/pages/LoanDetailPage.tsx`, `src/pages/ActiveLoansPage.tsx`, `src/pages/ClientsPage.tsx`, `src/pages/ClientDetailPage.tsx`, `src/pages/DailyReportPage.tsx`, `src/pages/OverdueLoansPage.tsx`
- `src/components/ClientForm.tsx`
- `src/lib/loan-utils.ts` (labels)

## Validação
- `tsc --noEmit` via build automático.
- Smoke test mental: pagamento com caixa fechado deve falhar; renegociação deve aparecer no relatório diário; status cancelled não deve virar overdue.

Confirma para eu prosseguir?