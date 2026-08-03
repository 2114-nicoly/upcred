-- =====================================================================
-- CORREÇÃO DA ETAPA DE ESTORNOS
-- =====================================================================

CREATE OR REPLACE FUNCTION public.reverse_cash_movement_tx(
  p_movement_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid            uuid := auth.uid();
  v_caller_worker  uuid;
  v_caller_admin   uuid;
  v_is_super       boolean := false;
  v_mov            public.cash_movements%ROWTYPE;
  v_cb             public.cash_balance%ROWTYPE;
  v_reason         text;
  v_worker         uuid;
  v_admin          uuid;
  v_cash_date      date;
  v_today_sp       date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_amount         numeric;
  v_abs            numeric;
  v_dc             record;
  v_loan           public.loans%ROWTYPE;
  v_cnt            int := 0;
  v_orig_event_id  uuid;
  v_orig_metadata  jsonb;
  v_rev_mov_id     uuid;
  v_rev_event_id   uuid;
  v_rev_type       text;
  v_label          text;
  v_rem_before     numeric;
  v_bal_after      numeric := 0;
  v_paid_base      numeric := 0;
  v_paid_before    numeric := 0;
  v_paid_after     numeric := 0;
  v_total_paid     numeric := 0;
  v_remaining      numeric := 0;
  v_paid_at        timestamptz;
  v_interest_total numeric := 0;
  v_to_interest    numeric := 0;
  v_to_principal   numeric := 0;
  v_pen_left       numeric := 0;
  v_pen_available  numeric := 0;
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

  PERFORM pg_advisory_xact_lock(hashtextextended(p_movement_id::text, 0));

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

  SELECT count(*) INTO v_cnt
    FROM public.daily_events de
   WHERE (de.id = v_mov.daily_event_id OR de.cash_movement_id = p_movement_id)
     AND de.admin_id = v_admin
     AND de.worker_id IS NOT DISTINCT FROM v_worker
     AND de.reverses_event_id IS NULL;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Não foi possível identificar com segurança o lançamento vinculado a esta movimentação. O estorno foi cancelado.';
  END IF;

  SELECT de.id, de.metadata INTO v_orig_event_id, v_orig_metadata
    FROM public.daily_events de
   WHERE (de.id = v_mov.daily_event_id OR de.cash_movement_id = p_movement_id)
     AND de.admin_id = v_admin
     AND de.worker_id IS NOT DISTINCT FROM v_worker
     AND de.reverses_event_id IS NULL
   FOR UPDATE;

  IF v_orig_event_id IS NULL THEN
    RAISE EXCEPTION 'Não foi possível identificar com segurança o lançamento vinculado a esta movimentação. O estorno foi cancelado.';
  END IF;

  SELECT * INTO v_cb
    FROM public.cash_balance
   WHERE worker_id IS NOT DISTINCT FROM v_worker
     AND admin_id = v_admin
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não existe saldo de caixa para esta empresa e trabalhador. O estorno foi cancelado.';
  END IF;

  v_label := CASE v_mov.type
    WHEN 'recebimento_normal' THEN 'pagamento'
    WHEN 'recebimento_multa'  THEN 'multa'
    WHEN 'entrada_manual'     THEN 'entrada manual'
    WHEN 'saida_manual'       THEN 'saída manual'
    WHEN 'ajuste_manual'      THEN 'ajuste manual'
    ELSE 'despesa' END;

  v_rev_type := CASE WHEN v_mov.type IN ('recebimento_normal','recebimento_multa')
                     THEN 'estorno_pagamento' ELSE 'estorno_manual' END;

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

    v_rem_before := NULLIF(v_orig_metadata->>'remaining_balance_before','')::numeric;
    IF v_rem_before IS NULL THEN
      RAISE EXCEPTION 'Este pagamento não possui os dados congelados (saldo anterior) necessários para um estorno seguro. O estorno foi cancelado.';
    END IF;

    v_paid_base := CASE
      WHEN v_loan.is_imported_ongoing THEN
        COALESCE(v_loan.initial_remaining_balance,
                 GREATEST(0, COALESCE(v_loan.total_amount,0) - COALESCE(v_loan.amount_already_paid,0)))
      ELSE COALESCE(v_loan.total_amount, 0)
    END;

    v_interest_total := GREATEST(0, COALESCE(v_loan.total_amount,0) - COALESCE(v_loan.amount,0));
    v_paid_before    := GREATEST(0, v_paid_base - v_rem_before);
    v_paid_after     := v_paid_before + v_abs;
    v_to_interest    := GREATEST(0, LEAST(v_paid_after, v_interest_total) - LEAST(v_paid_before, v_interest_total));
    v_to_principal   := GREATEST(0, v_abs - v_to_interest);

    v_bal_after := LEAST(COALESCE(v_loan.total_amount, 0), COALESCE(v_loan.remaining_balance, 0) + v_abs);

    UPDATE public.loans
       SET remaining_balance = v_bal_after,
           status = CASE
                      WHEN v_bal_after <= 0.01 THEN 'paid'
                      WHEN status = 'paid' THEN 'open'
                      ELSE status END
     WHERE id = v_loan.id;

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
               status = CASE WHEN r.due_date < v_today_sp THEN 'overdue' ELSE 'pending' END,
               paid_at = NULL
         WHERE id = r.id;
      END IF;
    END LOOP;

  ELSIF v_mov.type = 'recebimento_multa' THEN
    IF v_loan.id IS NULL THEN RAISE EXCEPTION 'Multa sem empréstimo vinculado.'; END IF;

    SELECT COALESCE(SUM(COALESCE(paid_amount,0)),0) INTO v_pen_available
      FROM public.installments
     WHERE loan_id = v_loan.id AND is_penalty = true;

    IF v_abs > v_pen_available + 0.01 THEN
      RAISE EXCEPTION 'O valor do estorno é maior do que a multa efetivamente paga. O estorno foi cancelado.';
    END IF;

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
        WHEN r.due_date < v_today_sp THEN 'overdue'
        ELSE 'pending' END;
      UPDATE public.installments
         SET paid_amount = v_new_paid,
             status = v_new_status,
             paid_at = CASE WHEN v_new_status = 'paid' THEN r.paid_at ELSE NULL END
       WHERE id = r.id;
    END LOOP;

    IF v_pen_left > 0.01 THEN
      RAISE EXCEPTION 'O valor do estorno é maior do que a multa efetivamente paga. O estorno foi cancelado.';
    END IF;
  END IF;

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
    v_cash_date, v_rev_type, v_mov.client_id, v_mov.loan_id, v_mov.installment_id,
    v_amount_in, v_amount_out, 'Estorno de ' || v_label || ' — Motivo: ' || v_reason,
    'estorno', v_rev_mov_id,
    jsonb_build_object(
      'reverses_movement_id', p_movement_id,
      'reverses_event_id', v_orig_event_id,
      'original_type', v_mov.type,
      'original_amount', v_amount,
      'reversal_amount', -v_amount,
      'restored_interest', v_to_interest,
      'restored_principal', v_to_principal,
      'net_effect', 0,
      'reversal_reason', v_reason,
      'original_metadata', v_orig_metadata
    ),
    v_uid, v_worker, v_admin, v_orig_event_id, v_reason
  ) RETURNING id INTO v_rev_event_id;

  UPDATE public.cash_movements SET daily_event_id = v_rev_event_id WHERE id = v_rev_mov_id;

  UPDATE public.cash_movements
     SET reversed_at = now(), reversed_by = v_uid,
         reversal_movement_id = v_rev_mov_id, reversal_reason = v_reason
   WHERE id = p_movement_id;

  UPDATE public.daily_events
     SET reversed_at = now(), reversed_by = v_uid,
         reversal_event_id = v_rev_event_id, reversal_reason = v_reason
   WHERE id = v_orig_event_id;

  UPDATE public.cash_balance
     SET available_cash = available_cash - v_amount,
         money_lent = money_lent + CASE WHEN v_mov.type = 'recebimento_normal' THEN v_to_principal ELSE 0 END,
         interest_receivable = interest_receivable + CASE WHEN v_mov.type = 'recebimento_normal' THEN v_to_interest ELSE 0 END,
         penalty_receivable = penalty_receivable + CASE WHEN v_mov.type = 'recebimento_multa' THEN v_abs ELSE 0 END,
         updated_at = now()
   WHERE id = v_cb.id;

  PERFORM public.log_audit(
    CASE WHEN v_mov.type IN ('recebimento_normal','recebimento_multa')
         THEN 'desfazer_pagamento' ELSE 'estorno_manual' END,
    'cash', p_movement_id,
    jsonb_build_object('type', v_mov.type, 'amount', v_amount, 'cash_date', v_cash_date,
                       'client_id', v_mov.client_id, 'loan_id', v_mov.loan_id,
                       'observation', v_mov.observation),
    jsonb_build_object('reversal_movement_id', v_rev_mov_id, 'reversal_event_id', v_rev_event_id,
                       'original_event_id', v_orig_event_id, 'reversal_amount', -v_amount,
                       'restored_interest', v_to_interest, 'restored_principal', v_to_principal,
                       'net_effect', 0, 'reversal_reason', v_reason, 'cash_date', v_cash_date),
    v_reason, v_worker
  );

  RETURN jsonb_build_object(
    'movement_id', p_movement_id,
    'reversal_movement_id', v_rev_mov_id,
    'reversal_event_id', v_rev_event_id,
    'original_event_id', v_orig_event_id,
    'original_amount', v_amount,
    'reversal_amount', -v_amount,
    'restored_interest', v_to_interest,
    'restored_principal', v_to_principal,
    'net_effect', 0
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.reverse_cash_movement_tx(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_cash_movement_tx(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.register_manual_movement(
  p_cash_date date,
  p_type text,
  p_amount numeric,
  p_observation text DEFAULT NULL,
  p_category text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_worker uuid;
  v_admin  uuid;
  v_cb     public.cash_balance%ROWTYPE;
  v_dc     record;
  v_delta  numeric;
  v_in     numeric := 0;
  v_out    numeric := 0;
  v_obs    text;
  v_mov_id uuid;
  v_ev_id  uuid;
  v_before numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_type NOT IN ('entrada_manual','saida_manual','ajuste_manual','despesa') THEN
    RAISE EXCEPTION 'Tipo de movimentação inválido.';
  END IF;
  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'Informe um valor válido.';
  END IF;
  IF p_type <> 'ajuste_manual' AND p_amount <= 0 THEN
    RAISE EXCEPTION 'Informe um valor maior que zero.';
  END IF;
  IF p_cash_date IS NULL THEN
    RAISE EXCEPTION 'Data do caixa não informada.';
  END IF;

  v_worker := public.get_worker_id(v_uid);
  v_admin  := public.get_admin_id(v_uid);
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa deste usuário. A movimentação foi cancelada.';
  END IF;

  IF p_type = 'ajuste_manual' AND v_worker IS NOT NULL THEN
    RAISE EXCEPTION 'Somente o administrador pode ajustar o saldo do caixa.';
  END IF;

  SELECT * INTO v_dc
    FROM public.daily_cash
   WHERE cash_date = p_cash_date
     AND worker_id IS NOT DISTINCT FROM v_worker
     AND admin_id = v_admin
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caixa do dia (%) ainda não foi aberto.', p_cash_date;
  END IF;
  IF v_dc.status <> 'open' THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar a movimentação.', p_cash_date;
  END IF;

  SELECT * INTO v_cb
    FROM public.cash_balance
   WHERE worker_id IS NOT DISTINCT FROM v_worker
     AND admin_id = v_admin
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não existe saldo de caixa para esta empresa e trabalhador. A movimentação foi cancelada.';
  END IF;
  v_before := COALESCE(v_cb.available_cash, 0);

  IF p_type = 'ajuste_manual' THEN
    v_delta := p_amount - v_before;
    v_obs := COALESCE(NULLIF(btrim(COALESCE(p_observation,'')), ''),
                      'Ajuste: saldo definido para ' || to_char(p_amount, 'FM999999999.00'));
  ELSIF p_type = 'entrada_manual' THEN
    v_delta := p_amount;
    v_obs := NULLIF(btrim(COALESCE(p_observation,'')), '');
  ELSE
    v_delta := -p_amount;
    v_obs := NULLIF(btrim(COALESCE(p_observation,'')), '');
    IF p_type = 'despesa' THEN
      IF p_category IS NULL OR length(btrim(p_category)) = 0 THEN
        RAISE EXCEPTION 'Categoria da despesa é obrigatória.';
      END IF;
      IF v_obs IS NULL OR length(v_obs) < 3 THEN
        RAISE EXCEPTION 'Descrição da despesa é obrigatória (mín. 3 caracteres).';
      END IF;
      v_obs := '[' || btrim(p_category) || '] ' || v_obs;
    END IF;
  END IF;

  IF v_delta >= 0 THEN v_in := v_delta; v_out := 0; ELSE v_in := 0; v_out := abs(v_delta); END IF;

  INSERT INTO public.cash_movements (
    type, amount, observation, cash_date, user_id, worker_id, admin_id
  ) VALUES (
    p_type, v_delta, v_obs, p_cash_date, v_uid, v_worker, v_admin
  ) RETURNING id INTO v_mov_id;

  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation, origin,
    user_id, worker_id, admin_id, cash_movement_id, metadata
  ) VALUES (
    p_cash_date, p_type, v_in, v_out, v_obs, 'geral',
    v_uid, v_worker, v_admin, v_mov_id,
    jsonb_build_object(
      'requested_amount', p_amount,
      'delta', v_delta,
      'cash_before', v_before,
      'cash_after', v_before + v_delta,
      'category', p_category
    )
  ) RETURNING id INTO v_ev_id;

  UPDATE public.cash_movements SET daily_event_id = v_ev_id WHERE id = v_mov_id;

  UPDATE public.cash_balance
     SET available_cash = available_cash + v_delta,
         updated_at = now()
   WHERE id = v_cb.id;

  PERFORM public.log_audit(
    CASE p_type
      WHEN 'entrada_manual' THEN 'aporte'
      WHEN 'saida_manual'   THEN 'retirada'
      WHEN 'ajuste_manual'  THEN 'ajuste_caixa'
      ELSE 'despesa' END,
    'cash', v_ev_id, NULL,
    jsonb_build_object(
      'type', p_type, 'amount', p_amount, 'delta', v_delta,
      'cash_date', p_cash_date, 'movement_id', v_mov_id, 'daily_event_id', v_ev_id,
      'cash_before', v_before, 'cash_after', v_before + v_delta, 'category', p_category
    ),
    v_obs, v_worker
  );

  RETURN jsonb_build_object(
    'movement_id', v_mov_id,
    'event_id', v_ev_id,
    'daily_event_id', v_ev_id,
    'delta', v_delta,
    'cash_before', v_before,
    'cash_after', v_before + v_delta
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.register_manual_movement(date, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_manual_movement(date, text, numeric, text, text) TO authenticated;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'build_daily_cash_snapshot_v2_legacy'
  ) THEN
    ALTER FUNCTION public.build_daily_cash_snapshot_v2(uuid)
      RENAME TO build_daily_cash_snapshot_v2_legacy;
  END IF;
END
$do$;

CREATE OR REPLACE FUNCTION public.build_daily_cash_snapshot_v2(p_daily_cash_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  dc record;
  v_date date; v_worker uuid; v_admin uuid;
  v_payload jsonb;
  v_total_in numeric := 0; v_total_out numeric := 0;
  v_estornos numeric := 0; v_estornos_count int := 0;
  v_reversed jsonb;
BEGIN
  v_payload := public.build_daily_cash_snapshot_v2_legacy(p_daily_cash_id);
  IF v_payload IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id;
  IF dc.id IS NULL THEN RAISE EXCEPTION 'caixa não encontrado para snapshot'; END IF;
  v_date := dc.cash_date; v_worker := dc.worker_id; v_admin := dc.admin_id;

  WITH base AS (
    SELECT * FROM public.daily_events de
     WHERE de.cash_date = v_date
       AND de.worker_id IS NOT DISTINCT FROM v_worker
       AND de.admin_id = v_admin
       AND de.event_type NOT IN ('emprestimo_importado','renovacao_absorvida','ajuste_fechamento','caixa_aberto','caixa_fechado')
  ),
  net AS (
    SELECT b.* FROM base b
     WHERE b.reversed_at IS NULL
        OR b.reversal_event_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM base c WHERE c.reverses_event_id = b.id)
  ),
  rev AS (SELECT b.* FROM base b WHERE b.reverses_event_id IS NOT NULL)
  SELECT
    (SELECT COALESCE(SUM(n.amount_in),0) FROM net n),
    (SELECT COALESCE(SUM(n.amount_out),0) FROM net n),
    (SELECT COALESCE(SUM(abs(COALESCE(r.amount_in,0)) + abs(COALESCE(r.amount_out,0))),0) FROM rev r),
    (SELECT COUNT(*)::int FROM rev r)
  INTO v_total_in, v_total_out, v_estornos, v_estornos_count;

  SELECT COALESCE(jsonb_agg(to_jsonb(de) ORDER BY de.created_at DESC), '[]'::jsonb)
    INTO v_reversed
    FROM public.daily_events de
   WHERE de.cash_date = v_date
     AND de.worker_id IS NOT DISTINCT FROM v_worker
     AND de.admin_id = v_admin
     AND (de.reversed_at IS NOT NULL OR de.reverses_event_id IS NOT NULL);

  v_payload := v_payload
    || jsonb_build_object(
         'totals', COALESCE(v_payload->'totals', '{}'::jsonb) || jsonb_build_object(
            'total_in', v_total_in,
            'total_out', v_total_out,
            'estornos', v_estornos,
            'estornos_count', v_estornos_count
         ),
         'reversed_events', v_reversed
       );

  IF v_payload->'daily_summary' IS NOT NULL AND jsonb_typeof(v_payload->'daily_summary') = 'object' THEN
    v_payload := v_payload || jsonb_build_object(
      'daily_summary', (v_payload->'daily_summary') || jsonb_build_object('reversedToday', v_estornos)
    );
  END IF;

  RETURN v_payload;
END;
$fn$;

REVOKE ALL ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.build_daily_cash_snapshot_v2_legacy(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.build_daily_cash_snapshot_v2_legacy(uuid) TO service_role;