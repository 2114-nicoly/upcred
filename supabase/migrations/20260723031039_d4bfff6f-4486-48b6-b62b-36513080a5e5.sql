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
  v_expected numeric := 0; v_diff numeric := 0;
  v_adj_in numeric := 0; v_adj_out numeric := 0;
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

  v_expected := v_opening + v_received + v_penalty + v_manual_in
                - v_lent - v_manual_out - v_expenses;

  v_diff := COALESCE(p_counted, v_expected) - v_expected;

  IF ABS(v_diff) > 0.01 AND (p_note IS NULL OR length(trim(p_note)) < 3) THEN
    RAISE EXCEPTION 'observação obrigatória quando há diferença entre valor contado e esperado';
  END IF;

  IF ABS(v_diff) > 0.01 THEN
    IF v_diff > 0 THEN v_adj_in := v_diff; ELSE v_adj_out := -v_diff; END IF;

    INSERT INTO public.daily_events (
      cash_date, event_type, amount_in, amount_out, observation,
      origin, user_id, worker_id, admin_id, metadata
    ) VALUES (
      p_cash_date, 'ajuste_fechamento', v_adj_in, v_adj_out,
      'Ajuste de Fechamento ('
        || CASE WHEN v_diff > 0 THEN 'sobra' ELSE 'falta' END
        || ' de ' || to_char(ABS(v_diff), 'FM999G999G990D00') || ')'
        || CASE WHEN p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN ' — ' || p_note ELSE '' END,
      'fechamento_caixa', auth.uid(), v_worker, v_admin,
      jsonb_build_object(
        'adjustment_type', CASE WHEN v_diff > 0 THEN 'positive' ELSE 'negative' END,
        'expected', v_expected,
        'counted', p_counted,
        'difference', v_diff,
        'cash_date', p_cash_date
      )
    );

    IF v_worker IS NOT NULL THEN
      UPDATE public.cash_balance
         SET available_cash = COALESCE(available_cash,0) + v_diff,
             updated_at = now()
       WHERE worker_id = v_worker;
    ELSE
      UPDATE public.cash_balance
         SET available_cash = COALESCE(available_cash,0) + v_diff,
             updated_at = now()
       WHERE worker_id IS NULL AND admin_id = v_admin;
    END IF;

    PERFORM public.log_audit(
      'ajuste_fechamento_caixa','cash',v_id,
      jsonb_build_object('expected', v_expected),
      jsonb_build_object(
        'cash_date', p_cash_date,
        'expected', v_expected,
        'counted', p_counted,
        'difference', v_diff,
        'direction', CASE WHEN v_diff > 0 THEN 'positive' ELSE 'negative' END,
        'note', p_note
      ),
      p_note, v_worker
    );
  END IF;

  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation,
    origin, user_id, worker_id, admin_id
  ) VALUES (
    p_cash_date, 'caixa_fechado', 0, 0,
    'Caixa fechado' || CASE WHEN p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN ' — ' || p_note ELSE '' END,
    'caixa', auth.uid(), v_worker, v_admin
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
    expected_closing_balance=v_expected,
    counted_closing_balance=p_counted,
    closing_difference=v_diff,
    closing_note=p_note,
    closed_at=now(), closed_by=auth.uid()
  WHERE id=v_id;

  PERFORM public.log_audit('fechar_caixa','cash',v_id,NULL,
    jsonb_build_object(
      'cash_date',p_cash_date,
      'opening',v_opening,
      'received',v_received,
      'penalty_received',v_penalty,
      'lent',v_lent,
      'manual_in',v_manual_in,
      'manual_out',v_manual_out,
      'expenses',v_expenses,
      'expected',v_expected,
      'counted',p_counted,
      'diff',v_diff,
      'events',v_events
    ),
    p_note, v_worker);
  RETURN v_id;
END;
$$;