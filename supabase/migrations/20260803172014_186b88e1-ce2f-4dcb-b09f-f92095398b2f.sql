-- =====================================================================
-- ESTORNO TRANSACIONAL DE MOVIMENTAÇÕES FINANCEIRAS
-- =====================================================================

CREATE OR REPLACE FUNCTION public.reverse_cash_movement_tx(
  p_movement_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid            uuid := auth.uid();
  v_caller_worker  uuid;
  v_caller_admin   uuid;
  v_is_super       boolean := false;
  v_mov            public.cash_movements%ROWTYPE;
  v_reason         text;
  v_worker         uuid;
  v_admin          uuid;
  v_cash_date      date;
  v_amount         numeric;
  v_abs            numeric;
  v_dc             record;
  v_loan           public.loans%ROWTYPE;
  v_orig_event_id  uuid;
  v_orig_metadata  jsonb;
  v_rev_mov_id     uuid;
  v_rev_event_id   uuid;
  v_rev_type       text;
  v_rev_event_type text;
  v_label          text;
  v_bal_before     numeric := 0;
  v_bal_after      numeric := 0;
  v_paid_base      numeric := 0;
  v_total_paid     numeric := 0;
  v_remaining      numeric := 0;
  v_paid_at        timestamptz;
  v_interest_total numeric := 0;
  v_to_interest    numeric := 0;
  v_to_principal   numeric := 0;
  v_pen_left       numeric := 0;
  v_new_paid       numeric;
  v_new_status     text;
  v_amount_in      numeric := 0;
  v_amount_out     numeric := 0;
  r                record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_movement_id IS NULL THEN RAISE EXCEPTION 'Movimentação não informada.'; END IF;

  v_reason := btrim(COALESCE(p_reason, ''));
  IF length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Informe o motivo do estorno (mínimo 3 caracteres).';
  END IF;

  -- 1) Trava a movimentação original
  SELECT * INTO v_mov FROM public.cash_movements WHERE id = p_movement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Movimentação não encontrada.'; END IF;

  IF v_mov.reverses_movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'Esta movimentação já é um estorno e não pode ser estornada novamente.';
  END IF;
  IF v_mov.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Esta movimentação já foi estornada.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_movements WHERE reverses_movement_id = p_movement_id) THEN
    RAISE EXCEPTION 'Esta movimentação já foi estornada.';
  END IF;

  -- 2) Tipos suportados nesta etapa
  IF v_mov.type IN ('emprestimo','emprestimo_novo','renovacao','renegociacao') THEN
    RAISE EXCEPTION 'Empréstimos, renovações e renegociações não podem ser estornados por aqui. Use o cancelamento do empréstimo.';
  END IF;
  IF v_mov.type NOT IN ('recebimento_normal','recebimento_multa','entrada_manual','saida_manual','ajuste_manual','despesa') THEN
    RAISE EXCEPTION 'Tipo de lançamento não pode ser estornado automaticamente.';
  END IF;

  v_worker    := v_mov.worker_id;
  v_admin     := v_mov.admin_id;
  v_cash_date := v_mov.cash_date;
  v_amount    := COALESCE(v_mov.amount, 0);
  v_abs       := abs(v_amount);

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Movimentação sem empresa definida. O estorno foi cancelado.';
  END IF;
  IF v_cash_date IS NULL THEN
    RAISE EXCEPTION 'Movimentação sem data de caixa. O estorno foi cancelado.';
  END IF;

  -- 3) Autorização por escopo
  v_caller_worker := public.get_worker_id(v_uid);
  v_caller_admin  := public.get_admin_id(v_uid);
  v_is_super      := public.is_super_admin(v_uid);

  IF v_caller_worker IS NOT NULL THEN
    IF v_worker IS DISTINCT FROM v_caller_worker OR v_admin IS DISTINCT FROM v_caller_admin THEN
      RAISE EXCEPTION 'access denied';
    END IF;
  ELSIF public.has_role(v_uid, 'admin'::app_role) THEN
    IF v_caller_admin IS NULL OR v_admin <> v_caller_admin THEN
      RAISE EXCEPTION 'access denied';
    END IF;
  ELSIF NOT v_is_super THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  -- 4) Caixa do dia precisa existir e estar ABERTO (escopo exato)
  SELECT * INTO v_dc
    FROM public.daily_cash
   WHERE cash_date = v_cash_date
     AND worker_id IS NOT DISTINCT FROM v_worker
     AND admin_id = v_admin
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não existe caixa aberto nesta data. Abra o caixa antes de estornar.';
  END IF;
  IF v_dc.status <> 'open' THEN
    RAISE EXCEPTION 'O caixa deste dia está fechado. Solicite a reabertura antes de desfazer esta movimentação.';
  END IF;

  -- 5) Evento original vinculado
  SELECT id, metadata INTO v_orig_event_id, v_orig_metadata
    FROM public.daily_events
   WHERE (id = v_mov.daily_event_id OR cash_movement_id = p_movement_id)
     AND admin_id = v_admin
     AND worker_id IS NOT DISTINCT FROM v_worker
   ORDER BY created_at
   LIMIT 1;

  v_label := CASE v_mov.type
    WHEN 'recebimento_normal' THEN 'pagamento'
    WHEN 'recebimento_multa'  THEN 'multa'
    WHEN 'entrada_manual'     THEN 'entrada manual'
    WHEN 'saida_manual'       THEN 'saída manual'
    WHEN 'ajuste_manual'      THEN 'ajuste manual'
    ELSE 'despesa' END;

  IF v_mov.type IN ('recebimento_normal','recebimento_multa') THEN
    v_rev_type := 'estorno_pagamento';
    v_rev_event_type := 'estorno_pagamento';
  ELSE
    v_rev_type := 'estorno_manual';
    v_rev_event_type := 'estorno_manual';
  END IF;

  -- 6) Restauração de empréstimo / parcelas
  IF v_mov.loan_id IS NOT NULL THEN
    SELECT * INTO v_loan FROM public.loans WHERE id = v_mov.loan_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo não encontrado.'; END IF;
    IF v_loan.admin_id IS DISTINCT FROM v_admin OR v_loan.worker_id IS DISTINCT FROM v_worker THEN
      RAISE EXCEPTION 'access denied';
    END IF;
    PERFORM 1 FROM public.installments WHERE loan_id = v_loan.id FOR UPDATE;
  END IF;

  IF v_mov.type = 'recebimento_normal' THEN
    IF v_loan.id IS NULL THEN RAISE EXCEPTION 'Pagamento sem empréstimo vinculado.'; END IF;

    v_bal_before := COALESCE(v_loan.remaining_balance, 0);
    v_bal_after  := LEAST(COALESCE(v_loan.total_amount, 0), v_bal_before + v_abs);

    UPDATE public.loans
       SET remaining_balance = v_bal_after,
           status = CASE
                      WHEN v_bal_after <= 0.01 THEN 'paid'
                      WHEN status = 'paid' THEN 'open'
                      ELSE status END
     WHERE id = v_loan.id;

    -- Redistribui as parcelas pelo total que continua pago
    v_paid_base := CASE
      WHEN v_loan.is_imported_ongoing THEN
        COALESCE(v_loan.initial_remaining_balance,
                 GREATEST(0, COALESCE(v_loan.total_amount,0) - COALESCE(v_loan.amount_already_paid,0)))
      ELSE COALESCE(v_loan.total_amount, 0)
    END;
    v_total_paid := GREATEST(0, v_paid_base - v_bal_after);
    v_remaining  := v_total_paid;
    v_paid_at    := (v_cash_date::text || 'T12:00:00')::timestamp AT TIME ZONE 'UTC';

    FOR r IN
      SELECT * FROM public.installments
       WHERE loan_id = v_loan.id AND is_penalty = false
       ORDER BY number
    LOOP
      IF r.status IN ('cancelled','renegotiated') THEN CONTINUE; END IF;
      IF v_remaining >= r.amount - 0.01 THEN
        UPDATE public.installments
           SET paid_amount = r.amount, status = 'paid', paid_at = COALESCE(r.paid_at, v_paid_at)
         WHERE id = r.id;
        v_remaining := v_remaining - r.amount;
      ELSIF v_remaining > 0.01 THEN
        UPDATE public.installments
           SET paid_amount = v_remaining, status = 'partial', paid_at = COALESCE(r.paid_at, v_paid_at)
         WHERE id = r.id;
        v_remaining := 0;
      ELSE
        UPDATE public.installments
           SET paid_amount = 0,
               status = CASE WHEN r.due_date < v_cash_date THEN 'overdue' ELSE 'pending' END,
               paid_at = NULL
         WHERE id = r.id;
      END IF;
    END LOOP;

    v_interest_total := GREATEST(0, COALESCE(v_loan.total_amount,0) - COALESCE(v_loan.amount,0));
    v_to_interest    := GREATEST(0, LEAST(v_abs, v_interest_total - GREATEST(0, v_paid_base - v_bal_before)));
    v_to_principal   := v_abs - v_to_interest;

  ELSIF v_mov.type = 'recebimento_multa' THEN
    IF v_loan.id IS NULL THEN RAISE EXCEPTION 'Multa sem empréstimo vinculado.'; END IF;
    v_pen_left := v_abs;
    FOR r IN
      SELECT * FROM public.installments
       WHERE loan_id = v_loan.id AND is_penalty = true
       ORDER BY number DESC
    LOOP
      EXIT WHEN v_pen_left <= 0.01;
      v_new_paid := GREATEST(0, COALESCE(r.paid_amount,0) - LEAST(COALESCE(r.paid_amount,0), v_pen_left));
      v_pen_left := v_pen_left - LEAST(COALESCE(r.paid_amount,0), v_pen_left);
      v_new_status := CASE
        WHEN v_new_paid >= r.amount - 0.01 THEN 'paid'
        WHEN v_new_paid > 0.01 THEN 'partial'
        WHEN r.due_date < v_cash_date THEN 'overdue'
        ELSE 'pending' END;
      UPDATE public.installments
         SET paid_amount = v_new_paid,
             status = v_new_status,
             paid_at = CASE WHEN v_new_status = 'paid' THEN r.paid_at ELSE NULL END
       WHERE id = r.id;
    END LOOP;
  END IF;

  -- 7) Contrapartida (valor oposto), preservando o original
  INSERT INTO public.cash_movements (
    type, amount, client_id, loan_id, installment_id, observation, cash_date,
    user_id, worker_id, admin_id, reverses_movement_id, reversal_reason
  ) VALUES (
    v_rev_type, -v_amount, v_mov.client_id, v_mov.loan_id, v_mov.installment_id,
    'Estorno de ' || v_label || ' — Motivo: ' || v_reason, v_cash_date,
    v_uid, v_worker, v_admin, p_movement_id, v_reason
  ) RETURNING id INTO v_rev_mov_id;

  IF v_amount >= 0 THEN
    v_amount_in := 0; v_amount_out := v_abs;
  ELSE
    v_amount_in := v_abs; v_amount_out := 0;
  END IF;

  INSERT INTO public.daily_events (
    cash_date, event_type, client_id, loan_id, installment_id,
    amount_in, amount_out, observation, origin, cash_movement_id,
    metadata, user_id, worker_id, admin_id, reverses_event_id, reversal_reason
  ) VALUES (
    v_cash_date, v_rev_event_type, v_mov.client_id, v_mov.loan_id, v_mov.installment_id,
    v_amount_in, v_amount_out, 'Estorno de ' || v_label || ' — Motivo: ' || v_reason,
    'estorno', v_rev_mov_id,
    jsonb_build_object(
      'reverses_movement_id', p_movement_id,
      'reverses_event_id', v_orig_event_id,
      'original_type', v_mov.type,
      'original_amount', v_amount,
      'reversal_amount', -v_amount,
      'net_effect', 0,
      'reversal_reason', v_reason,
      'original_metadata', v_orig_metadata
    ),
    v_uid, v_worker, v_admin, v_orig_event_id, v_reason
  ) RETURNING id INTO v_rev_event_id;

  UPDATE public.cash_movements SET daily_event_id = v_rev_event_id WHERE id = v_rev_mov_id;

  -- 8) Marca original como estornado (movimentação + eventos vinculados)
  UPDATE public.cash_movements
     SET reversed_at = now(), reversed_by = v_uid,
         reversal_movement_id = v_rev_mov_id, reversal_reason = v_reason
   WHERE id = p_movement_id;

  UPDATE public.daily_events
     SET reversed_at = now(), reversed_by = v_uid,
         reversal_event_id = v_rev_event_id, reversal_reason = v_reason
   WHERE (id = v_mov.daily_event_id OR cash_movement_id = p_movement_id)
     AND admin_id = v_admin
     AND worker_id IS NOT DISTINCT FROM v_worker
     AND reversed_at IS NULL
     AND id <> v_rev_event_id;

  -- 9) Saldo do caixa: uma única atualização
  INSERT INTO public.cash_balance (worker_id, admin_id, available_cash, money_lent, interest_receivable, penalty_receivable)
  SELECT v_worker, v_admin, 0, 0, 0, 0
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cash_balance
     WHERE worker_id IS NOT DISTINCT FROM v_worker AND admin_id = v_admin
  );

  UPDATE public.cash_balance
     SET available_cash = available_cash - v_amount,
         money_lent = money_lent + CASE WHEN v_mov.type = 'recebimento_normal' THEN v_to_principal ELSE 0 END,
         interest_receivable = interest_receivable + CASE WHEN v_mov.type = 'recebimento_normal' THEN v_to_interest ELSE 0 END,
         penalty_receivable = penalty_receivable + CASE WHEN v_mov.type = 'recebimento_multa' THEN v_abs ELSE 0 END,
         updated_at = now()
   WHERE worker_id IS NOT DISTINCT FROM v_worker AND admin_id = v_admin;

  -- 10) Auditoria na mesma transação
  PERFORM public.log_audit(
    CASE WHEN v_mov.type IN ('recebimento_normal','recebimento_multa')
         THEN 'desfazer_pagamento' ELSE 'estorno_manual' END,
    'cash', p_movement_id,
    jsonb_build_object('type', v_mov.type, 'amount', v_amount, 'cash_date', v_cash_date,
                       'client_id', v_mov.client_id, 'loan_id', v_mov.loan_id,
                       'observation', v_mov.observation),
    jsonb_build_object('reversal_movement_id', v_rev_mov_id, 'reversal_event_id', v_rev_event_id,
                       'original_event_id', v_orig_event_id, 'reversal_amount', -v_amount,
                       'net_effect', 0, 'reversal_reason', v_reason, 'cash_date', v_cash_date),
    v_reason, v_worker
  );

  RETURN jsonb_build_object(
    'movement_id', p_movement_id,
    'reversal_movement_id', v_rev_mov_id,
    'reversal_event_id', v_rev_event_id,
    'original_amount', v_amount,
    'reversal_amount', -v_amount,
    'net_effect', 0
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.reverse_cash_movement_tx(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_cash_movement_tx(uuid, text) TO authenticated;

-- =====================================================================
-- TOTAIS SEM IMPACTO DUPLO NO FECHAMENTO
-- Entradas/saídas totais consideram original + contrapartida (efeito líquido),
-- enquanto os totais por tipo continuam ignorando o original estornado.
-- =====================================================================
CREATE OR REPLACE FUNCTION public._close_daily_cash_core(
  p_daily_cash_id uuid,
  p_counted numeric,
  p_note text,
  p_origin text,
  p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $core$
DECLARE
  dc record;
  v_date date; v_worker uuid; v_admin uuid;
  v_opening numeric := 0;
  v_received numeric := 0; v_penalty numeric := 0; v_lent numeric := 0;
  v_manual_in numeric := 0; v_manual_out numeric := 0; v_expenses numeric := 0;
  v_in numeric := 0; v_out numeric := 0;
  v_not_paid int := 0; v_events int := 0;
  v_expected numeric := 0; v_counted numeric := 0; v_final numeric := 0; v_diff numeric := 0;
  v_payload jsonb; v_version int; v_reopen_reason text := NULL;
  v_auto boolean;
BEGIN
  IF p_origin NOT IN ('manual','automatic_opened','automatic_not_opened') THEN
    RAISE EXCEPTION 'origem de fechamento inválida';
  END IF;
  v_auto := p_origin <> 'manual';

  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id FOR UPDATE;
  IF dc.id IS NULL THEN
    RAISE EXCEPTION 'caixa deste dia ainda não foi aberto';
  END IF;
  IF dc.status = 'closed' THEN
    RAISE EXCEPTION 'caixa já está fechado';
  END IF;

  v_date := dc.cash_date; v_worker := dc.worker_id; v_admin := dc.admin_id;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa e o trabalhador deste caixa. O fechamento foi cancelado.';
  END IF;
  v_opening := COALESCE(dc.opening_balance, 0);

  WITH base AS (
    SELECT * FROM public.daily_events
     WHERE cash_date = v_date
       AND event_type NOT IN ('emprestimo_importado','renovacao_absorvida','ajuste_fechamento','caixa_aberto','caixa_fechado')
       AND worker_id IS NOT DISTINCT FROM v_worker
       AND admin_id = v_admin
  ),
  ev AS (SELECT * FROM base WHERE reversed_at IS NULL),
  -- Efeito líquido: original estornado COM contrapartida + a própria contrapartida.
  -- Estorno antigo sem contrapartida continua ignorado (não corrigido automaticamente).
  net AS (
    SELECT * FROM base b
     WHERE b.reversed_at IS NULL
        OR b.reversal_event_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM base c WHERE c.reverses_event_id = b.id)
  )
  SELECT
    COALESCE(SUM(CASE WHEN e.event_type='pagamento' THEN e.amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN e.event_type='recebimento_multa' THEN e.amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN e.event_type IN ('emprestimo_novo','renovacao','renegociacao') THEN e.amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN e.event_type='entrada_manual' THEN e.amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN e.event_type='saida_manual' THEN e.amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN e.event_type='despesa' THEN e.amount_out ELSE 0 END),0),
    (SELECT COALESCE(SUM(n.amount_in),0) FROM net n),
    (SELECT COALESCE(SUM(n.amount_out),0) FROM net n),
    COALESCE(SUM(CASE WHEN e.event_type='nao_pagou' THEN 1 ELSE 0 END),0)::int,
    COUNT(*)::int
  INTO v_received, v_penalty, v_lent, v_manual_in, v_manual_out, v_expenses, v_in, v_out, v_not_paid, v_events
  FROM ev e;

  v_expected := (v_received + v_penalty + v_manual_in) - (v_lent + v_manual_out + v_expenses);

  IF v_auto THEN
    v_counted := v_expected;
    v_diff := 0;
  ELSE
    v_counted := COALESCE(p_counted, v_expected);
    IF v_counted < 0 THEN
      RAISE EXCEPTION 'O valor contado não pode ser negativo.';
    END IF;
    v_diff := v_counted - v_expected;
    IF abs(v_diff) > 0.01 AND (p_note IS NULL OR length(trim(p_note)) < 3) THEN
      RAISE EXCEPTION 'Há diferença entre o valor contado e o esperado. Escreva uma observação com pelo menos 3 caracteres.';
    END IF;
  END IF;

  v_final := v_opening + v_expected;

  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation,
    origin, user_id, worker_id, admin_id
  )
  SELECT
    v_date, 'caixa_fechado', 0, 0,
    CASE
      WHEN p_origin = 'automatic_not_opened' THEN 'Caixa não foi aberto e foi fechado automaticamente'
      WHEN p_origin = 'automatic_opened' THEN 'Caixa fechado automaticamente'
      ELSE 'Caixa fechado' || CASE WHEN p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN ' — ' || p_note ELSE '' END
    END,
    'caixa', p_actor, v_worker, v_admin
  WHERE p_origin = 'manual'
     OR NOT EXISTS (
       SELECT 1 FROM public.daily_events de
        WHERE de.cash_date = v_date AND de.event_type = 'caixa_fechado'
          AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin
     );

  UPDATE public.daily_cash SET
    status='closed',
    total_in=v_in, total_out=v_out,
    total_received=v_received, total_penalty_received=v_penalty,
    total_lent=v_lent,
    total_manual_in=v_manual_in, total_manual_out=v_manual_out,
    total_not_paid_count=v_not_paid,
    total_items_treated=v_events,
    total_events_count=v_events,
    expected_closing_balance=v_final,
    counted_closing_balance=v_counted,
    closing_difference=v_diff,
    closing_note=p_note,
    close_origin=p_origin,
    closed_at=now(), closed_by=p_actor
  WHERE id = p_daily_cash_id;

  v_payload := public.build_daily_cash_snapshot_v2(p_daily_cash_id);
  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'Não foi possível congelar todas as informações. O caixa continua aberto.';
  END IF;
  v_payload := v_payload || jsonb_build_object('close_origin', p_origin);

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM public.daily_cash_snapshots WHERE daily_cash_id = p_daily_cash_id;

  IF v_version > 1 THEN
    SELECT al.new_value->>'reason' INTO v_reopen_reason
      FROM public.audit_logs al
     WHERE al.action_type = 'reabrir_caixa'
       AND al.entity_id = p_daily_cash_id
       AND (al.new_value->>'cash_date') = v_date::text
     ORDER BY al.created_at DESC
     LIMIT 1;
    v_payload := v_payload || jsonb_build_object('reopen_reason', v_reopen_reason);
  END IF;

  INSERT INTO public.daily_cash_snapshots (
    daily_cash_id, cash_date, worker_id, admin_id,
    closed_at, closed_by, version, reopen_reason, payload
  ) VALUES (
    p_daily_cash_id, v_date, v_worker, v_admin,
    now(), p_actor, v_version, v_reopen_reason, v_payload
  );

  PERFORM public.log_audit('fechar_caixa','cash',p_daily_cash_id,NULL,
    jsonb_build_object(
      'cash_date',v_date,'opening',v_opening,'received',v_received,
      'penalty_received',v_penalty,'manual_in',v_manual_in,'lent',v_lent,
      'manual_out',v_manual_out,'expenses',v_expenses,
      'expected_worker_cash',v_expected,'counted',v_counted,'difference',v_diff,
      'final_available',v_final,'events',v_events,'close_origin',p_origin
    ),
    p_note, v_worker);

  RETURN jsonb_build_object('cash_id', p_daily_cash_id, 'version', v_version, 'close_origin', p_origin);
END;
$core$;

REVOKE ALL ON FUNCTION public._close_daily_cash_core(uuid, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._close_daily_cash_core(uuid, numeric, text, text, uuid) TO service_role;