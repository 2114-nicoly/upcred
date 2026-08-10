-- Correção genérica e auditável do saldo-base de caixas ABERTOS cujo
-- Caixa Disponível gravado ficou MAIOR que (abertura + movimentos do dia).
-- Sem UUIDs fixos, sem valores fixos, sem tocar em eventos/movimentos.

WITH alvo AS (
  SELECT cb.id AS balance_id,
         cb.admin_id,
         cb.worker_id,
         cb.available_cash,
         cb.ledger_base_amount,
         dc.cash_date,
         round(COALESCE(dc.opening_balance, 0), 2) AS opening,
         (SELECT round(COALESCE(SUM(m.amount), 0), 2)
            FROM public.cash_movements m
           WHERE m.admin_id IS NOT DISTINCT FROM cb.admin_id
             AND m.worker_id IS NOT DISTINCT FROM cb.worker_id
             AND m.cash_date = dc.cash_date
             AND NOT (m.reversed_at IS NOT NULL
                      AND m.reversal_movement_id IS NULL
                      AND m.reverses_movement_id IS NULL)) AS day_net,
         (SELECT round(COALESCE(SUM(m.amount), 0), 2)
            FROM public.cash_movements m
           WHERE m.admin_id IS NOT DISTINCT FROM cb.admin_id
             AND m.worker_id IS NOT DISTINCT FROM cb.worker_id
             AND NOT (m.reversed_at IS NOT NULL
                      AND m.reversal_movement_id IS NULL
                      AND m.reverses_movement_id IS NULL)) AS ledger_net
    FROM public.cash_balance cb
    JOIN public.daily_cash dc
      ON dc.admin_id IS NOT DISTINCT FROM cb.admin_id
     AND dc.worker_id IS NOT DISTINCT FROM cb.worker_id
     AND dc.status = 'open'
),
corrigir AS (
  SELECT a.*,
         round(a.opening + a.day_net, 2) AS saldo_correto,
         round(a.opening + a.day_net - a.ledger_net, 2) AS base_correta
    FROM alvo a
   WHERE round(a.available_cash - (a.opening + a.day_net), 2) > 0.01
),
log AS (
  INSERT INTO public.audit_logs (user_role, worker_id, admin_id, action_type, entity_type, entity_id,
                                 old_value, new_value, observation)
  SELECT 'system', c.worker_id, c.admin_id, 'ajuste_reconciliacao', 'cash_balance', c.balance_id,
         jsonb_build_object('available_cash', c.available_cash,
                            'ledger_base_amount', c.ledger_base_amount),
         jsonb_build_object('available_cash', c.saldo_correto,
                            'ledger_base_amount', c.base_correta,
                            'cash_date', c.cash_date,
                            'opening_balance', c.opening,
                            'day_net', c.day_net,
                            'ledger_net', c.ledger_net,
                            'difference', round(c.available_cash - c.saldo_correto, 2)),
         'Correção de reconciliação hardcoded aplicada durante caixa aberto: saldo-base recalculado pelos registros reais do escopo.'
    FROM corrigir c
  RETURNING 1
)
UPDATE public.cash_balance cb
   SET ledger_base_amount = c.base_correta,
       updated_at = now()
  FROM corrigir c
 WHERE cb.id = c.balance_id;
