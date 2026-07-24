
CREATE OR REPLACE FUNCTION public.close_daily_cash_v2(p_cash_date date, p_counted numeric, p_note text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid; v_admin uuid;
  v_id uuid; v_status text;
  v_opening numeric := 0;
  v_received numeric := 0; v_penalty numeric := 0; v_lent numeric := 0;
  v_manual_in numeric := 0; v_manual_out numeric := 0;
  v_expenses numeric := 0;
  v_in numeric := 0; v_out numeric := 0;
  v_not_paid int := 0; v_events int := 0;
  v_counted numeric := 0; v_final numeric := 0;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

  IF v_worker IS NOT NULL THEN
    SELECT id, status, opening_balance INTO v_id, v_status, v_opening FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id = v_worker LIMIT 1;
  ELSIF v_admin IS NOT NULL THEN
    SELECT id, status, opening_balance INTO v_id, v_status, v_opening FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id = v_admin LIMIT 1;
  ELSE
    RAISE EXCEPTION 'usuário sem escopo (worker/admin) para fechar caixa';
  END IF;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'caixa deste dia ainda não foi aberto';
  END IF;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'caixa já está fechado';
  END IF;

  v_opening := COALESCE(v_opening, 0);

  -- Recalcula totais reais do dia (imutável, a partir do ledger).
  WITH ev AS (
    SELECT * FROM public.daily_events
     WHERE cash_date = p_cash_date
       AND reversed_at IS NULL
       AND event_type NOT IN ('emprestimo_importado','renovacao_absorvida','ajuste_fechamento','caixa_aberto','caixa_fechado')
       AND (CASE WHEN v_worker IS NOT NULL THEN worker_id = v_worker
                 ELSE worker_id IS NULL AND admin_id = v_admin END)
  )
  SELECT
    COALESCE(SUM(CASE WHEN event_type='pagamento' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='recebimento_multa' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type IN ('emprestimo_novo','renovacao','renegociacao') THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='entrada_manual' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='saida_manual' THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='despesa' THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(amount_in),0),
    COALESCE(SUM(amount_out),0),
    COALESCE(SUM(CASE WHEN event_type='nao_pagou' THEN 1 ELSE 0 END),0)::int,
    COUNT(*)::int
  INTO v_received, v_penalty, v_lent, v_manual_in, v_manual_out, v_expenses, v_in, v_out, v_not_paid, v_events
  FROM ev;

  -- Dinheiro contado no caixa = totalIn - totalOut (calculado, sem input).
  -- Ignora o p_counted enviado pelo cliente (mantido por compatibilidade de assinatura).
  v_counted := (v_received + v_penalty + v_manual_in)
             - (v_lent + v_manual_out + v_expenses);
  v_final := v_opening + v_counted;

  -- Marca evento informativo de fechamento (não movimenta caixa).
  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation,
    origin, user_id, worker_id, admin_id
  ) VALUES (
    p_cash_date, 'caixa_fechado', 0, 0,
    'Caixa fechado' || CASE WHEN p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN ' — ' || p_note ELSE '' END,
    'caixa', auth.uid(), v_worker, v_admin
  );

  -- Salva snapshot imutável. Não altera cash_balance (não reaplica movimentações).
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
    closing_difference=0,
    closing_note=p_note,
    closed_at=now(), closed_by=auth.uid()
  WHERE id=v_id;

  PERFORM public.log_audit('fechar_caixa','cash',v_id,NULL,
    jsonb_build_object(
      'cash_date',p_cash_date,
      'opening',v_opening,
      'received',v_received,
      'penalty_received',v_penalty,
      'manual_in',v_manual_in,
      'lent',v_lent,
      'manual_out',v_manual_out,
      'expenses',v_expenses,
      'counted',v_counted,
      'final_available',v_final,
      'events',v_events
    ),
    p_note, v_worker);
  RETURN v_id;
END;
$$;
