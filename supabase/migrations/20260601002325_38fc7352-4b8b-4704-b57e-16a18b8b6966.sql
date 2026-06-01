-- Expand daily_cash with full daily totals + add close/reopen RPCs

ALTER TABLE public.daily_cash
  ADD COLUMN IF NOT EXISTS opening_balance numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_in numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_out numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_lent numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_manual_in numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_manual_out numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_events_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expected_closing_balance numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS closed_by uuid,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_by uuid,
  ADD COLUMN IF NOT EXISTS reopen_reason text;

-- Close daily cash: aggregates non-reversed daily_events for current scope.
CREATE OR REPLACE FUNCTION public.close_daily_cash(p_cash_date date)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid;
  v_admin  uuid;
  v_id uuid;
  v_status text;
  v_opening numeric := 0;
  v_received numeric := 0;
  v_penalty numeric := 0;
  v_lent numeric := 0;
  v_manual_in numeric := 0;
  v_manual_out numeric := 0;
  v_in numeric := 0;
  v_out numeric := 0;
  v_not_paid int := 0;
  v_events int := 0;
  v_expected numeric := 0;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

  -- find or create row for this scope/date
  IF v_worker IS NOT NULL THEN
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id = v_worker LIMIT 1;
  ELSIF v_admin IS NOT NULL THEN
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id = v_admin LIMIT 1;
  ELSE
    RAISE EXCEPTION 'usuário sem escopo (worker/admin) para fechar caixa';
  END IF;

  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'caixa já está fechado';
  END IF;

  -- opening balance: yesterday's expected_closing for same scope (default 0)
  SELECT COALESCE(expected_closing_balance, 0) INTO v_opening
    FROM public.daily_cash
   WHERE cash_date < p_cash_date
     AND (CASE WHEN v_worker IS NOT NULL THEN worker_id = v_worker
               ELSE worker_id IS NULL AND admin_id = v_admin END)
     AND status = 'closed'
   ORDER BY cash_date DESC LIMIT 1;
  v_opening := COALESCE(v_opening, 0);

  -- aggregate non-reversed daily_events for scope/date
  WITH ev AS (
    SELECT * FROM public.daily_events
     WHERE cash_date = p_cash_date
       AND reversed_at IS NULL
       AND (CASE WHEN v_worker IS NOT NULL THEN worker_id = v_worker
                 ELSE worker_id IS NULL AND admin_id = v_admin END)
  )
  SELECT
    COALESCE(SUM(CASE WHEN event_type='pagamento' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='recebimento_multa' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type IN ('emprestimo_novo','renovacao','renegociacao') THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='entrada_manual' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='saida_manual' THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(amount_in),0),
    COALESCE(SUM(amount_out),0),
    COALESCE(SUM(CASE WHEN event_type='nao_pagou' THEN 1 ELSE 0 END),0)::int,
    COUNT(*)::int
  INTO v_received, v_penalty, v_lent, v_manual_in, v_manual_out, v_in, v_out, v_not_paid, v_events
  FROM ev;

  v_expected := v_opening + v_in - v_out;

  IF v_id IS NULL THEN
    INSERT INTO public.daily_cash (
      cash_date, worker_id, admin_id, status,
      opening_balance, total_in, total_out,
      total_received, total_penalty_received, total_lent,
      total_manual_in, total_manual_out,
      total_not_paid_count, total_items_treated, total_events_count,
      expected_closing_balance, closed_at, closed_by, user_id
    ) VALUES (
      p_cash_date, v_worker, v_admin, 'closed',
      v_opening, v_in, v_out,
      v_received, v_penalty, v_lent,
      v_manual_in, v_manual_out,
      v_not_paid, v_events, v_events,
      v_expected, now(), auth.uid(), auth.uid()
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE public.daily_cash SET
      status='closed',
      opening_balance=v_opening,
      total_in=v_in, total_out=v_out,
      total_received=v_received, total_penalty_received=v_penalty,
      total_lent=v_lent,
      total_manual_in=v_manual_in, total_manual_out=v_manual_out,
      total_not_paid_count=v_not_paid,
      total_items_treated=v_events,
      total_events_count=v_events,
      expected_closing_balance=v_expected,
      closed_at=now(), closed_by=auth.uid()
    WHERE id=v_id;
  END IF;

  PERFORM public.log_audit('fechar_caixa','cash',v_id,NULL,
    jsonb_build_object('cash_date',p_cash_date,'expected',v_expected,'events',v_events),
    NULL,v_worker);
  RETURN v_id;
END;
$$;

-- Reopen daily cash: requires reason, logs audit.
CREATE OR REPLACE FUNCTION public.reopen_daily_cash(p_cash_date date, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid; v_admin uuid; v_id uuid; v_status text;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'motivo da reabertura é obrigatório';
  END IF;
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

  IF v_worker IS NOT NULL THEN
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id = v_worker LIMIT 1;
  ELSE
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id = v_admin LIMIT 1;
  END IF;

  IF v_id IS NULL THEN RAISE EXCEPTION 'caixa não encontrado'; END IF;
  IF v_status <> 'closed' THEN RAISE EXCEPTION 'caixa não está fechado'; END IF;

  UPDATE public.daily_cash
     SET status='open',
         reopened_at=now(), reopened_by=auth.uid(), reopen_reason=p_reason
   WHERE id=v_id;

  PERFORM public.log_audit('reabrir_caixa','cash',v_id,NULL,
    jsonb_build_object('cash_date',p_cash_date,'reason',p_reason), p_reason, v_worker);
  RETURN v_id;
END;
$$;