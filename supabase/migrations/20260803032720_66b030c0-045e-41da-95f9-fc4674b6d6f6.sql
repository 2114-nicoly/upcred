-- Helper: formata delta de unidades de progresso ("+1", "+0,5")
CREATE OR REPLACE FUNCTION public._fmt_units_delta(p_before numeric, p_after numeric)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
DECLARE v_delta numeric; v_rounded numeric;
BEGIN
  IF p_before IS NULL OR p_after IS NULL THEN RETURN NULL; END IF;
  v_delta := GREATEST(0, p_after - p_before);
  v_rounded := floor(v_delta * 10) / 10.0;
  IF abs(v_rounded - round(v_rounded)) < 0.05 THEN
    RETURN '+' || trim(to_char(round(v_rounded), 'FM999999999'));
  END IF;
  RETURN '+' || replace(trim(to_char(v_rounded, 'FM999999990.0')), '.', ',');
END $fn$;

-- Snapshot autoritativo construído no banco (payload v2)
CREATE OR REPLACE FUNCTION public.build_daily_cash_snapshot_v2(p_daily_cash_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  dc record;
  v_date date; v_worker uuid; v_admin uuid;
  v_worker_name text; v_admin_name text;
  v_opening numeric := 0;
  v_received numeric := 0; v_penalty numeric := 0;
  v_manual_in numeric := 0; v_manual_out numeric := 0; v_expenses numeric := 0;
  v_new_loans numeric := 0; v_renewals numeric := 0; v_lent numeric := 0;
  v_total_in numeric := 0; v_total_out numeric := 0;
  v_not_paid_count int := 0; v_events_count int := 0;
  v_penalty_paid numeric := 0;
  v_expected numeric := 0; v_counted numeric := 0; v_final numeric := 0;
  v_previsto numeric := 0; v_falta numeric := 0; v_recebido_previsto numeric := 0;
  v_atrasado numeric := 0; v_cash_expected numeric := 0;
  v_events jsonb; v_reversed jsonb; v_renewals_ev jsonb;
  v_client_names jsonb; v_paid_groups jsonb; v_np jsonb; v_new_loans_j jsonb;
  v_expense_breakdown jsonb; v_pending jsonb; v_overdue jsonb; v_portfolio jsonb;
  v_available_cash numeric;
  v_saldo_rua numeric := 0; v_clientes_ativos int := 0; v_emprestimos_ativos int := 0;
  v_clientes_atrasados int := 0; v_valor_atrasado numeric := 0; v_parcelas_vencidas int := 0;
  v_actor_id uuid := auth.uid();
  v_actor_name text; v_actor_role text;
  v_payload jsonb;
BEGIN
  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id;
  IF dc.id IS NULL THEN RAISE EXCEPTION 'caixa não encontrado para snapshot'; END IF;

  v_date := dc.cash_date; v_worker := dc.worker_id; v_admin := dc.admin_id;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa e o trabalhador deste caixa. O fechamento foi cancelado.';
  END IF;

  SELECT w.nome INTO v_worker_name FROM public.workers w
   WHERE w.id = v_worker AND w.parent_admin_id = v_admin;
  IF v_worker IS NOT NULL AND v_worker_name IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa e o trabalhador deste caixa. O fechamento foi cancelado.';
  END IF;

  SELECT a.nome INTO v_admin_name FROM public.admins a WHERE a.id = v_admin;
  IF v_admin_name IS NULL THEN
    RAISE EXCEPTION 'Não foi possível congelar todas as informações. O caixa continua aberto.';
  END IF;

  v_opening := GREATEST(0, COALESCE(dc.opening_balance, 0));

  -- ===== Totais do dia (eventos válidos, escopo explícito) =====
  SELECT
    COALESCE(SUM(CASE WHEN event_type='pagamento' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='recebimento_multa' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='entrada_manual' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='saida_manual' THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='despesa' THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='emprestimo_novo' THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type IN ('renovacao','renegociacao') THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(amount_in),0),
    COALESCE(SUM(amount_out),0),
    COALESCE(SUM(CASE WHEN event_type='nao_pagou' THEN 1 ELSE 0 END),0)::int,
    COUNT(*)::int
  INTO v_received, v_penalty, v_manual_in, v_manual_out, v_expenses,
       v_new_loans, v_renewals, v_total_in, v_total_out, v_not_paid_count, v_events_count
  FROM public.daily_events de
  WHERE de.cash_date = v_date
    AND de.reversed_at IS NULL
    AND de.worker_id IS NOT DISTINCT FROM v_worker
    AND de.admin_id = v_admin
    AND de.event_type NOT IN ('emprestimo_importado','renovacao_absorvida','ajuste_fechamento','caixa_aberto','caixa_fechado');

  v_lent := v_new_loans + v_renewals;
  v_expected := (v_received + v_penalty + v_manual_in) - (v_lent + v_manual_out + v_expenses);
  v_counted := COALESCE(dc.counted_closing_balance, v_expected);
  v_final := COALESCE(dc.expected_closing_balance, v_opening + v_expected);

  SELECT COALESCE(SUM(cm.amount),0) INTO v_penalty_paid
    FROM public.cash_movements cm
   WHERE cm.cash_date = v_date AND cm.type = 'recebimento_multa' AND cm.reversed_at IS NULL
     AND cm.worker_id IS NOT DISTINCT FROM v_worker AND cm.admin_id = v_admin;

  -- ===== Eventos congelados =====
  SELECT COALESCE(jsonb_agg(to_jsonb(de) ORDER BY de.created_at DESC), '[]'::jsonb)
    INTO v_events
    FROM public.daily_events de
   WHERE de.cash_date = v_date AND de.reversed_at IS NULL
     AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin;

  SELECT COALESCE(jsonb_agg(to_jsonb(de) ORDER BY de.created_at DESC), '[]'::jsonb)
    INTO v_reversed
    FROM public.daily_events de
   WHERE de.cash_date = v_date AND de.reversed_at IS NOT NULL
     AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin;

  SELECT COALESCE(jsonb_agg(to_jsonb(de) ORDER BY de.created_at DESC), '[]'::jsonb)
    INTO v_renewals_ev
    FROM public.daily_events de
   WHERE de.cash_date = v_date AND de.reversed_at IS NULL AND de.event_type = 'renovacao'
     AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin;

  -- ===== Pagamentos (SOMENTE metadata congelado) =====
  SELECT COALESCE(jsonb_agg(g ORDER BY g->>'createdAt'), '[]'::jsonb) INTO v_paid_groups
  FROM (
    SELECT jsonb_build_object(
      'eventId', de.id,
      'movementId', COALESCE(de.metadata->>'cash_movement_id', de.cash_movement_id::text, ''),
      'clientName', COALESCE(de.metadata->>'client_name', 'Cliente'),
      'clientId', COALESCE(de.metadata->>'client_id', de.client_id::text, ''),
      'loanId', COALESCE(de.metadata->>'loan_id', de.loan_id::text, ''),
      'totalPaid', COALESCE((de.metadata->>'payment_amount')::numeric, de.amount_in, 0),
      'createdAt', de.created_at,
      'cashDate', COALESCE(de.metadata->>'cash_date', de.cash_date::text),
      'hasFrozenProgress', f.frozen,
      'instAmount', CASE WHEN f.frozen THEN f.inst_amount END,
      'totalAmount', CASE WHEN f.frozen THEN f.inst_amount * f.total_inst END,
      'installmentCount', CASE WHEN f.frozen THEN f.total_inst END,
      'paidBefore', CASE WHEN f.frozen THEN GREATEST(0, f.inst_amount * f.total_inst - f.rem_before) END,
      'paidAfter', CASE WHEN f.frozen THEN GREATEST(0, f.inst_amount * f.total_inst - f.rem_after) END,
      'remainingBefore', CASE WHEN f.frozen THEN f.rem_before END,
      'remainingAfter', CASE WHEN f.frozen THEN f.rem_after END,
      'progressBeforeFormatted', CASE WHEN f.frozen THEN f.prog_before END,
      'progressAfterFormatted', CASE WHEN f.frozen THEN f.prog_after END,
      'progressDeltaFormatted', CASE WHEN f.frozen THEN COALESCE(
          public._fmt_units_delta(f.units_before, f.units_after),
          CASE WHEN f.advanced IS NOT NULL THEN '+' || f.advanced::text END) END,
      'installmentsAdvanced', CASE WHEN f.frozen THEN f.advanced END,
      'installmentIds', COALESCE(f.inst_ids, '[]'::jsonb)
    ) AS g, de.created_at
    FROM public.daily_events de
    CROSS JOIN LATERAL (
      SELECT
        NULLIF(de.metadata->>'remaining_balance_before','')::numeric AS rem_before,
        NULLIF(de.metadata->>'remaining_balance_after','')::numeric AS rem_after,
        de.metadata->>'installment_progress_before' AS prog_before,
        de.metadata->>'installment_progress_after' AS prog_after,
        NULLIF(de.metadata->>'total_installments','')::numeric AS total_inst,
        NULLIF(de.metadata->>'installment_amount','')::numeric AS inst_amount,
        NULLIF(de.metadata->>'progress_units_before','')::numeric AS units_before,
        NULLIF(de.metadata->>'progress_units_after','')::numeric AS units_after,
        NULLIF(de.metadata->>'installments_advanced','')::numeric AS advanced,
        CASE WHEN jsonb_typeof(de.metadata->'affected_installments') = 'array' THEN (
          SELECT COALESCE(jsonb_agg(x->>'installment_id'), '[]'::jsonb)
            FROM jsonb_array_elements(de.metadata->'affected_installments') x
           WHERE x->>'installment_id' IS NOT NULL
        ) END AS inst_ids,
        (
          NULLIF(de.metadata->>'remaining_balance_before','') IS NOT NULL AND
          NULLIF(de.metadata->>'remaining_balance_after','') IS NOT NULL AND
          de.metadata->>'installment_progress_before' IS NOT NULL AND
          de.metadata->>'installment_progress_after' IS NOT NULL AND
          NULLIF(de.metadata->>'total_installments','') IS NOT NULL AND
          NULLIF(de.metadata->>'installment_amount','') IS NOT NULL AND
          jsonb_typeof(de.metadata->'affected_installments') = 'array'
        ) AS frozen
    ) f
    WHERE de.cash_date = v_date AND de.reversed_at IS NULL AND de.event_type = 'pagamento'
      AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin
  ) s;

  -- ===== Não pagamentos =====
  SELECT COALESCE(jsonb_agg(
    to_jsonb(nm) || jsonb_build_object('installment', (
      SELECT to_jsonb(i) || jsonb_build_object('loans', (
        SELECT to_jsonb(l) || jsonb_build_object('clients', (
          SELECT jsonb_build_object('id', c.id, 'name', c.name) FROM public.clients c WHERE c.id = l.client_id
        )) FROM public.loans l WHERE l.id = i.loan_id
      )) FROM public.installments i WHERE i.id = nm.installment_id
    ))
  ), '[]'::jsonb) INTO v_np
  FROM public.not_paid_marks nm
  WHERE nm.mark_date = v_date
    AND nm.worker_id IS NOT DISTINCT FROM v_worker AND nm.admin_id = v_admin;

  -- ===== Novos empréstimos do dia =====
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', l.id, 'amount', l.amount, 'total_amount', l.total_amount,
    'remaining_balance', l.remaining_balance, 'status', l.status,
    'installment_count', l.installment_count, 'payment_type', l.payment_type,
    'loan_date', l.loan_date, 'renewed_from_loan_id', l.renewed_from_loan_id,
    'worker_id', l.worker_id, 'admin_id', l.admin_id,
    'clients', (SELECT jsonb_build_object('id', c.id, 'name', c.name) FROM public.clients c WHERE c.id = l.client_id)
  )), '[]'::jsonb) INTO v_new_loans_j
  FROM public.loans l
  WHERE l.loan_date = v_date
    AND l.worker_id IS NOT DISTINCT FROM v_worker AND l.admin_id = v_admin;

  -- ===== Nomes de clientes =====
  SELECT COALESCE(jsonb_object_agg(c.id::text, c.name), '{}'::jsonb) INTO v_client_names
  FROM public.clients c
  WHERE c.id IN (
    SELECT de.client_id FROM public.daily_events de
     WHERE de.cash_date = v_date AND de.client_id IS NOT NULL
       AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin
    UNION
    SELECT l.client_id FROM public.loans l
     WHERE l.loan_date = v_date AND l.client_id IS NOT NULL
       AND l.worker_id IS NOT DISTINCT FROM v_worker AND l.admin_id = v_admin
  );

  -- ===== Despesas por categoria =====
  SELECT COALESCE(jsonb_object_agg(cat, total), '{}'::jsonb) INTO v_expense_breakdown
  FROM (
    SELECT COALESCE(de.metadata->>'category', 'Outros') AS cat, SUM(COALESCE(de.amount_out,0)) AS total
      FROM public.daily_events de
     WHERE de.cash_date = v_date AND de.reversed_at IS NULL AND de.event_type = 'despesa'
       AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin
     GROUP BY 1
  ) e;

  -- ===== Métricas de cobrança do dia =====
  SELECT
    COALESCE(SUM(i.amount),0),
    COALESCE(SUM(GREATEST(i.amount - COALESCE(i.paid_amount,0), 0)),0)
  INTO v_previsto, v_falta
  FROM public.installments i
  JOIN public.loans l ON l.id = i.loan_id
  JOIN public.clients c ON c.id = l.client_id
  WHERE i.due_date = v_date
    AND i.is_penalty = false
    AND i.status NOT IN ('cancelled','renegotiated')
    AND l.status NOT IN ('cancelled','renegotiated')
    AND c.archived_at IS NULL
    AND l.worker_id IS NOT DISTINCT FROM v_worker AND l.admin_id = v_admin;
  v_falta := GREATEST(0, v_falta);
  v_recebido_previsto := GREATEST(0, v_previsto - v_falta);

  SELECT
    COALESCE(SUM(GREATEST(i.amount - COALESCE(i.paid_amount,0), 0)),0),
    COUNT(*)::int
  INTO v_atrasado, v_parcelas_vencidas
  FROM public.installments i
  JOIN public.loans l ON l.id = i.loan_id
  JOIN public.clients c ON c.id = l.client_id
  WHERE i.due_date < v_date
    AND i.is_penalty = false
    AND i.status IN ('pending','partial','overdue')
    AND l.status IN ('open','overdue')
    AND l.remaining_balance > 0.01
    AND c.archived_at IS NULL
    AND (i.amount - COALESCE(i.paid_amount,0)) > 0.01
    AND l.worker_id IS NOT DISTINCT FROM v_worker AND l.admin_id = v_admin;
  v_atrasado := GREATEST(0, v_atrasado);
  v_valor_atrasado := round(v_atrasado, 2);

  v_cash_expected := v_opening + v_received + v_penalty + v_manual_in - v_lent - v_manual_out - v_expenses;

  -- ===== Pendentes no fechamento (sem nenhuma ação válida no dia) =====
  SELECT COALESCE(jsonb_agg(p ORDER BY p->>'due_date'), '[]'::jsonb) INTO v_pending
  FROM (
    SELECT jsonb_build_object(
      'installment_id', i.id,
      'loan_id', l.id,
      'client_id', l.client_id,
      'client_name', COALESCE(c.name, 'Cliente'),
      'worker_id', l.worker_id,
      'worker_name', v_worker_name,
      'installment_number', i.number,
      'total_installments', l.installment_count,
      'installment_amount', i.amount,
      'paid_amount', COALESCE(i.paid_amount, 0),
      'pending_amount', GREATEST(0, i.amount - COALESCE(i.paid_amount,0)),
      'due_date', i.due_date,
      'overdue_days', GREATEST(0, (v_date - i.due_date)),
      'loan_remaining_balance', l.remaining_balance,
      'progress_at_close', public._fmt_progress(
        GREATEST(0, COALESCE(l.total_amount,0) - COALESCE(l.remaining_balance,0)),
        CASE WHEN COALESCE(l.installment_count,0) > 0 THEN COALESCE(l.total_amount,0) / l.installment_count ELSE 0 END,
        l.installment_count),
      'status', 'Pendente no fechamento'
    ) AS p
    FROM public.loans l
    JOIN public.clients c ON c.id = l.client_id
    JOIN LATERAL (
      SELECT i2.* FROM public.installments i2
       WHERE i2.loan_id = l.id AND i2.is_penalty = false
         AND i2.status IN ('pending','partial','overdue')
         AND i2.due_date <= v_date
       ORDER BY i2.number ASC LIMIT 1
    ) i ON true
    WHERE l.status IN ('open','overdue')
      AND l.remaining_balance > 0.01
      AND l.worker_id IS NOT DISTINCT FROM v_worker AND l.admin_id = v_admin
      AND NOT EXISTS (
        SELECT 1 FROM public.daily_events de
         WHERE de.cash_date = v_date AND de.reversed_at IS NULL AND de.loan_id = l.id
           AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin
           AND de.event_type IN ('pagamento','recebimento_multa','nao_pagou','renovacao','renegociacao','quitacao','emprestimo_novo')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.not_paid_marks nm
         WHERE nm.mark_date = v_date AND nm.loan_id = l.id
           AND nm.worker_id IS NOT DISTINCT FROM v_worker AND nm.admin_id = v_admin
      )
  ) s;

  -- ===== Clientes atrasados congelados =====
  SELECT COALESCE(jsonb_agg(o ORDER BY (o->>'overdue_days')::int DESC), '[]'::jsonb),
         COUNT(*)::int
    INTO v_overdue, v_clientes_atrasados
  FROM (
    SELECT jsonb_build_object(
      'client_id', g.client_id,
      'client_name', COALESCE(g.client_name, 'Cliente'),
      'worker_id', g.worker_id,
      'worker_name', v_worker_name,
      'overdue_installments_count', g.cnt,
      'overdue_total', g.total,
      'oldest_due_date', g.oldest,
      'overdue_days', GREATEST(0, (v_date - g.oldest)),
      'loan_remaining_balance', g.remaining,
      'last_payment', (
        SELECT jsonb_build_object('date', cm.cash_date, 'amount', cm.amount)
          FROM public.cash_movements cm
         WHERE cm.client_id = g.client_id AND cm.type = 'recebimento_normal'
           AND cm.reversed_at IS NULL AND cm.cash_date <= v_date
           AND cm.worker_id IS NOT DISTINCT FROM v_worker AND cm.admin_id = v_admin
         ORDER BY cm.cash_date DESC, cm.created_at DESC LIMIT 1
      ),
      'installments', g.installments
    ) AS o
    FROM (
      SELECT l.client_id, c.name AS client_name, l.worker_id,
             COUNT(*)::int AS cnt,
             SUM(GREATEST(0, i.amount - COALESCE(i.paid_amount,0))) AS total,
             MIN(i.due_date) AS oldest,
             SUM(DISTINCT l.remaining_balance) AS remaining,
             jsonb_agg(jsonb_build_object(
               'installment_id', i.id, 'loan_id', l.id, 'number', i.number,
               'amount', i.amount, 'paid_amount', COALESCE(i.paid_amount,0),
               'pending_amount', GREATEST(0, i.amount - COALESCE(i.paid_amount,0)),
               'due_date', i.due_date,
               'overdue_days', GREATEST(0, (v_date - i.due_date))
             ) ORDER BY i.due_date) AS installments
        FROM public.installments i
        JOIN public.loans l ON l.id = i.loan_id
        JOIN public.clients c ON c.id = l.client_id
       WHERE i.due_date < v_date
         AND i.is_penalty = false
         AND i.status IN ('pending','partial','overdue')
         AND l.status IN ('open','overdue')
         AND l.remaining_balance > 0.01
         AND c.archived_at IS NULL
         AND (i.amount - COALESCE(i.paid_amount,0)) > 0.01
         AND l.worker_id IS NOT DISTINCT FROM v_worker AND l.admin_id = v_admin
       GROUP BY l.client_id, c.name, l.worker_id
    ) g
  ) s2;

  -- ===== Situação da carteira =====
  SELECT COALESCE(SUM(l.remaining_balance),0),
         COUNT(DISTINCT l.client_id)::int,
         COUNT(*)::int
    INTO v_saldo_rua, v_clientes_ativos, v_emprestimos_ativos
    FROM public.loans l
   WHERE l.status IN ('open','overdue') AND l.remaining_balance > 0.01
     AND l.worker_id IS NOT DISTINCT FROM v_worker AND l.admin_id = v_admin;

  SELECT cb.available_cash INTO v_available_cash
    FROM public.cash_balance cb
   WHERE cb.worker_id IS NOT DISTINCT FROM v_worker
     AND cb.admin_id IS NOT DISTINCT FROM v_admin
   LIMIT 1;
  IF v_available_cash IS NULL THEN
    RAISE EXCEPTION 'Não foi possível congelar todas as informações. O caixa continua aberto.';
  END IF;

  v_portfolio := jsonb_build_object(
    'available_cash', v_available_cash,
    'saldo_na_rua', v_saldo_rua,
    'clientes_ativos', v_clientes_ativos,
    'emprestimos_ativos', v_emprestimos_ativos,
    'clientes_atrasados', v_clientes_atrasados,
    'valor_atrasado', v_valor_atrasado,
    'parcelas_vencidas', v_parcelas_vencidas
  );

  -- ===== Responsável pelo fechamento =====
  SELECT a.nome INTO v_actor_name FROM public.admins a WHERE a.auth_user_id = v_actor_id;
  IF v_actor_name IS NULL THEN
    SELECT w.nome INTO v_actor_name FROM public.workers w WHERE w.auth_user_id = v_actor_id;
  END IF;
  SELECT ur.role::text INTO v_actor_role FROM public.user_roles ur
   WHERE ur.user_id = v_actor_id
   ORDER BY CASE ur.role::text WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END
   LIMIT 1;

  v_payload := jsonb_build_object(
    'version', 2,
    'cash_date', v_date,
    'scope', jsonb_build_object('worker_id', v_worker, 'admin_id', v_admin),
    'closed_at', COALESCE(dc.closed_at, now()),
    'closed_by', jsonb_build_object('id', v_actor_id, 'name', v_actor_name, 'role', v_actor_role),
    'observation', dc.closing_note,
    'totals', jsonb_build_object(
      'opening_balance', v_opening,
      'expected_worker_cash', v_expected,
      'counted_cash', v_counted,
      'final_cash', v_final,
      'received', v_received,
      'penalty', v_penalty,
      'manual_in', v_manual_in,
      'manual_out', v_manual_out,
      'expenses', v_expenses,
      'new_loans', v_new_loans,
      'renewals', v_renewals,
      'lent', v_lent,
      'total_in', v_total_in,
      'total_out', v_total_out,
      'not_paid_count', v_not_paid_count,
      'events_count', v_events_count,
      'penalty_paid_today', v_penalty_paid
    ),
    'daily_summary', jsonb_build_object(
      'expectedToReceiveToday', v_previsto,
      'receivedToday', v_received + v_penalty,
      'receivedFromExpected', v_recebido_previsto,
      'pendingToReceiveToday', v_falta,
      'overdueAmount', v_atrasado,
      'cashExpectedForClosing', v_cash_expected
    ),
    'events', v_events,
    'reversed_events', v_reversed,
    'renewal_events', v_renewals_ev,
    'client_names', v_client_names,
    'paid_groups', v_paid_groups,
    'not_paid_marks', v_np,
    'new_loans', v_new_loans_j,
    'expense_breakdown', v_expense_breakdown,
    'pending_installments', v_pending,
    'overdue_clients', v_overdue,
    'portfolio_state', v_portfolio,
    'scope_names', jsonb_build_object('worker_name', v_worker_name, 'admin_name', v_admin_name)
  );

  -- validação de completude
  IF v_payload->'totals' IS NULL OR v_payload->'daily_summary' IS NULL
     OR v_payload->'portfolio_state' IS NULL OR v_payload->'scope_names' IS NULL
     OR jsonb_typeof(v_payload->'events') <> 'array'
     OR jsonb_typeof(v_payload->'reversed_events') <> 'array'
     OR jsonb_typeof(v_payload->'paid_groups') <> 'array'
     OR jsonb_typeof(v_payload->'not_paid_marks') <> 'array'
     OR jsonb_typeof(v_payload->'new_loans') <> 'array'
     OR jsonb_typeof(v_payload->'pending_installments') <> 'array'
     OR jsonb_typeof(v_payload->'overdue_clients') <> 'array' THEN
    RAISE EXCEPTION 'Não foi possível congelar todas as informações. O caixa continua aberto.';
  END IF;

  RETURN v_payload;
END $fn$;

REVOKE ALL ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) FROM public;
REVOKE ALL ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) TO service_role;

-- ===== Fechamento público (sem payload vindo do navegador) =====
CREATE OR REPLACE FUNCTION public.close_daily_cash_with_snapshot(
  p_cash_date date,
  p_counted numeric,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_cash_id uuid;
  v_worker uuid; v_admin uuid;
  v_version int;
  v_reopen_reason text := NULL;
  v_payload jsonb;
BEGIN
  -- fecha o caixa (valida escopo autenticado, caixa aberto e existente)
  v_cash_id := public.close_daily_cash_v2(p_cash_date, p_counted, p_note);

  SELECT worker_id, admin_id INTO v_worker, v_admin
    FROM public.daily_cash WHERE id = v_cash_id;

  v_payload := public.build_daily_cash_snapshot_v2(v_cash_id);
  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'Não foi possível congelar todas as informações. O caixa continua aberto.';
  END IF;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM public.daily_cash_snapshots WHERE daily_cash_id = v_cash_id;

  IF v_version > 1 THEN
    SELECT al.new_value->>'reason' INTO v_reopen_reason
      FROM public.audit_logs al
     WHERE al.action_type = 'reabrir_caixa'
       AND (al.new_value->>'cash_date') = p_cash_date::text
     ORDER BY al.created_at DESC
     LIMIT 1;
    v_payload := v_payload || jsonb_build_object('reopen_reason', v_reopen_reason);
  END IF;

  INSERT INTO public.daily_cash_snapshots (
    daily_cash_id, cash_date, worker_id, admin_id,
    closed_at, closed_by, version, reopen_reason, payload
  ) VALUES (
    v_cash_id, p_cash_date, v_worker, v_admin,
    now(), auth.uid(), v_version, v_reopen_reason, v_payload
  );

  RETURN jsonb_build_object('cash_id', v_cash_id, 'version', v_version);
END $fn$;

REVOKE ALL ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text) TO authenticated;

-- versão antiga (com payload do navegador) deixa de ser executável pelo app
REVOKE ALL ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text, jsonb) FROM anon, authenticated;