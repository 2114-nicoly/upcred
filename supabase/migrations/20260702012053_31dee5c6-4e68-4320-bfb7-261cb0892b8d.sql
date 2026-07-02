-- Atualiza abertura e fechamento do caixa para usar cash_balance.available_cash
-- como referência única do valor disponível.

CREATE OR REPLACE FUNCTION public.open_daily_cash(p_cash_date date, p_worker_id uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_worker uuid;
  v_admin  uuid;
  v_caller_admin uuid;
  v_is_admin boolean;
  v_is_super boolean;
  v_id uuid;
  v_status text;
  v_opening numeric := 0;
  v_has_open_event boolean;
  v_target_worker_admin uuid;
BEGIN
  v_is_super := public.is_super_admin(auth.uid());
  v_is_admin := v_is_super OR public.has_role(auth.uid(),'admin'::app_role);
  v_caller_admin := public.get_admin_id(auth.uid());

  IF p_worker_id IS NOT NULL THEN
    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'apenas admin pode abrir caixa para outro trabalhador';
    END IF;
    SELECT parent_admin_id INTO v_target_worker_admin FROM public.workers WHERE id = p_worker_id;
    IF v_target_worker_admin IS NULL THEN
      RAISE EXCEPTION 'trabalhador não encontrado';
    END IF;
    IF NOT v_is_super AND v_target_worker_admin IS DISTINCT FROM v_caller_admin THEN
      RAISE EXCEPTION 'trabalhador não pertence à sua equipe';
    END IF;
    v_worker := p_worker_id;
    v_admin  := v_target_worker_admin;
  ELSE
    v_worker := public.get_worker_id(auth.uid());
    v_admin  := v_caller_admin;
  END IF;

  IF v_worker IS NULL AND v_admin IS NULL THEN
    RAISE EXCEPTION 'usuário sem escopo (worker/admin) para abrir caixa';
  END IF;

  IF v_worker IS NOT NULL THEN
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id = v_worker LIMIT 1;
  ELSE
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id = v_admin LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    IF v_status = 'open' THEN
      RETURN v_id;
    END IF;
    IF v_status = 'closed' THEN
      RAISE EXCEPTION 'caixa deste dia já foi fechado; reabra antes de operar';
    END IF;

    IF v_status IN ('cancelled_empty','void') THEN
      UPDATE public.daily_cash
         SET status = 'open',
             cancelled_at = NULL,
             cancelled_by = NULL,
             cancellation_reason = NULL,
             opened_at = now(),
             opened_by = auth.uid()
       WHERE id = v_id;

      SELECT EXISTS (
        SELECT 1 FROM public.daily_events de
         WHERE de.cash_date = p_cash_date
           AND de.event_type = 'caixa_aberto'
           AND de.worker_id IS NOT DISTINCT FROM v_worker
           AND de.admin_id IS NOT DISTINCT FROM v_admin
      ) INTO v_has_open_event;

      IF NOT v_has_open_event THEN
        INSERT INTO public.daily_events (
          cash_date, event_type, amount_in, amount_out, observation,
          origin, user_id, worker_id, admin_id
        ) VALUES (
          p_cash_date, 'caixa_aberto', 0, 0, 'Caixa reaberto após cancelamento',
          'caixa', auth.uid(), v_worker, v_admin
        );
      END IF;

      PERFORM public.log_audit('reabrir_caixa','cash',v_id,
        jsonb_build_object('status', v_status),
        jsonb_build_object('status','open','cash_date',p_cash_date,'action','reopen_after_cancel'),
        'Reabertura após cancelamento vazio', v_worker);
    END IF;

    RETURN v_id;
  END IF;

  -- Novo: opening_balance = cash_balance.available_cash atual do mesmo escopo.
  -- Nunca herda de fechamentos anteriores. Nunca fica negativo.
  IF v_worker IS NOT NULL THEN
    SELECT COALESCE(available_cash, 0) INTO v_opening
      FROM public.cash_balance
     WHERE worker_id = v_worker
     LIMIT 1;
  ELSE
    SELECT COALESCE(available_cash, 0) INTO v_opening
      FROM public.cash_balance
     WHERE worker_id IS NULL AND admin_id = v_admin
     LIMIT 1;
  END IF;
  v_opening := GREATEST(COALESCE(v_opening, 0), 0);

  INSERT INTO public.daily_cash (
    cash_date, worker_id, admin_id, status,
    opening_balance, opened_at, opened_by, user_id
  ) VALUES (
    p_cash_date, v_worker, v_admin, 'open',
    v_opening, now(), auth.uid(), auth.uid()
  ) RETURNING id INTO v_id;

  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation,
    origin, user_id, worker_id, admin_id
  ) VALUES (
    p_cash_date, 'caixa_aberto', 0, 0, 'Caixa aberto',
    'caixa', auth.uid(), v_worker, v_admin
  );

  PERFORM public.log_audit('reabrir_caixa','cash',v_id,NULL,
    jsonb_build_object('cash_date',p_cash_date,'opening_balance',v_opening,'action','open'),
    'Abertura do caixa', v_worker);
  RETURN v_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.close_daily_cash_v2(p_cash_date date, p_counted numeric, p_note text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid; v_admin uuid;
  v_id uuid; v_status text;
  v_opening numeric := 0;
  v_received numeric := 0; v_penalty numeric := 0; v_lent numeric := 0;
  v_manual_in numeric := 0; v_manual_out numeric := 0;
  v_in numeric := 0; v_out numeric := 0;
  v_not_paid int := 0; v_events int := 0;
  v_expected numeric := 0; v_diff numeric := 0;
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

  -- Totais do dia (apenas informativos/auditoria).
  WITH ev AS (
    SELECT * FROM public.daily_events
     WHERE cash_date = p_cash_date
       AND reversed_at IS NULL
       AND event_type <> 'emprestimo_importado'
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

  -- Novo: valor esperado = cash_balance.available_cash atual (fonte única da verdade).
  -- Já reflete abertura + todas as movimentações do dia.
  IF v_worker IS NOT NULL THEN
    SELECT COALESCE(available_cash, 0) INTO v_expected
      FROM public.cash_balance WHERE worker_id = v_worker LIMIT 1;
  ELSE
    SELECT COALESCE(available_cash, 0) INTO v_expected
      FROM public.cash_balance WHERE worker_id IS NULL AND admin_id = v_admin LIMIT 1;
  END IF;
  v_expected := COALESCE(v_expected, 0);
  v_diff := COALESCE(p_counted, v_expected) - v_expected;

  IF ABS(v_diff) > 0.01 AND (p_note IS NULL OR length(trim(p_note)) < 3) THEN
    RAISE EXCEPTION 'observação obrigatória quando há diferença entre valor contado e esperado';
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
    jsonb_build_object('cash_date',p_cash_date,'expected',v_expected,'counted',p_counted,'diff',v_diff,'events',v_events),
    p_note, v_worker);
  RETURN v_id;
END;
$$;