-- Add cash counting fields and v2 close RPC

ALTER TABLE public.daily_cash
  ADD COLUMN IF NOT EXISTS counted_closing_balance numeric,
  ADD COLUMN IF NOT EXISTS closing_difference numeric,
  ADD COLUMN IF NOT EXISTS closing_note text;

CREATE OR REPLACE FUNCTION public.close_daily_cash_v2(
  p_cash_date date,
  p_counted numeric,
  p_note text DEFAULT NULL
)
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
  v_diff numeric := 0;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

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

  SELECT COALESCE(expected_closing_balance, 0) INTO v_opening
    FROM public.daily_cash
   WHERE cash_date < p_cash_date
     AND (CASE WHEN v_worker IS NOT NULL THEN worker_id = v_worker
               ELSE worker_id IS NULL AND admin_id = v_admin END)
     AND status = 'closed'
   ORDER BY cash_date DESC LIMIT 1;
  v_opening := COALESCE(v_opening, 0);

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
  v_diff := COALESCE(p_counted, v_expected) - v_expected;

  IF ABS(v_diff) > 0.01 AND (p_note IS NULL OR length(trim(p_note)) < 3) THEN
    RAISE EXCEPTION 'observação obrigatória quando há diferença entre valor contado e esperado';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.daily_cash (
      cash_date, worker_id, admin_id, status,
      opening_balance, total_in, total_out,
      total_received, total_penalty_received, total_lent,
      total_manual_in, total_manual_out,
      total_not_paid_count, total_items_treated, total_events_count,
      expected_closing_balance, counted_closing_balance, closing_difference, closing_note,
      closed_at, closed_by, user_id
    ) VALUES (
      p_cash_date, v_worker, v_admin, 'closed',
      v_opening, v_in, v_out,
      v_received, v_penalty, v_lent,
      v_manual_in, v_manual_out,
      v_not_paid, v_events, v_events,
      v_expected, p_counted, v_diff, p_note,
      now(), auth.uid(), auth.uid()
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
      counted_closing_balance=p_counted,
      closing_difference=v_diff,
      closing_note=p_note,
      closed_at=now(), closed_by=auth.uid()
    WHERE id=v_id;
  END IF;

  PERFORM public.log_audit('fechar_caixa','cash',v_id,NULL,
    jsonb_build_object('cash_date',p_cash_date,'expected',v_expected,'counted',p_counted,'diff',v_diff,'events',v_events),
    p_note, v_worker);
  RETURN v_id;
END;
$$;