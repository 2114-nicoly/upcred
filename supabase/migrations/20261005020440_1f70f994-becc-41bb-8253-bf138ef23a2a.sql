CREATE OR REPLACE FUNCTION public._assert_closing_consistency(p_admin uuid, p_worker uuid, p_cash_date date, p_opening numeric)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Fechamento NÃO exige mais abertura + movimento do dia = Caixa Disponível.
  -- Diferenças vindas de outras datas são legítimas (dias fora da ordem).
  -- Mantém apenas a conferência REAL do ledger: saldo existe e
  -- available_cash = ledger_base_amount + soma líquida dos movimentos.
  PERFORM public._assert_open_cash_consistency(p_admin, p_worker);
END $function$;

REVOKE ALL ON FUNCTION public._assert_closing_consistency(uuid, uuid, date, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._assert_closing_consistency(uuid, uuid, date, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public._close_daily_cash_core(p_daily_cash_id uuid, p_counted numeric, p_note text, p_origin text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  dc record;
  v_date date; v_worker uuid; v_admin uuid;
  v_opening numeric := 0;
  v_received numeric := 0; v_penalty numeric := 0; v_lent numeric := 0;
  v_manual_in numeric := 0; v_manual_out numeric := 0; v_expenses numeric := 0;
  v_in numeric := 0; v_out numeric := 0;
  v_not_paid int := 0; v_events int := 0;
  v_raw_worker_expected numeric := 0; v_worker_expected numeric := 0;
  v_day_net numeric := 0;
  v_available numeric;
  v_basis jsonb; v_is_historic boolean := false; v_base numeric;
  v_other_dates numeric := 0;
  v_counted numeric := 0; v_final numeric := 0; v_diff numeric := 0;
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

  SELECT cb.available_cash INTO v_available
    FROM public.cash_balance cb
   WHERE cb.admin_id = v_admin
     AND cb.worker_id IS NOT DISTINCT FROM v_worker
   FOR UPDATE;

  IF v_available IS NULL THEN
    RAISE EXCEPTION 'Não foi possível carregar o Caixa Disponível deste trabalhador. O fechamento foi cancelado.';
  END IF;
  IF v_available < 0 THEN
    RAISE EXCEPTION 'O Caixa Disponível está negativo. Regularize o caixa antes de fechar.';
  END IF;

  -- Conferência real do ledger (não cronológica).
  PERFORM public._assert_closing_consistency(v_admin, v_worker, v_date, v_opening);
  v_basis := public._closing_basis(v_admin, v_worker, v_date, v_opening);
  v_is_historic := COALESCE((v_basis->>'is_historic')::boolean, false);
  -- Caixa final do dia = fotografia histórica: abertura + movimentos daquele dia.
  v_base := round((v_basis->>'historic_expected')::numeric, 2);
  -- Parte do Caixa Disponível explicada por movimentos de outras datas.
  v_other_dates := round(v_available - v_base, 2);

  IF v_base < 0 THEN
    RAISE EXCEPTION 'O saldo apurado para o dia % é negativo (R$ %). Regularize o caixa antes de fechar.',
      to_char(v_date, 'DD/MM/YYYY'), to_char(v_base, 'FM999999990.00');
  END IF;

  WITH base AS (
    SELECT * FROM public.daily_events
     WHERE cash_date = v_date
       AND event_type NOT IN ('emprestimo_importado','renovacao_absorvida','ajuste_fechamento','caixa_aberto','caixa_fechado')
       AND worker_id IS NOT DISTINCT FROM v_worker
       AND admin_id = v_admin
  ),
  ev AS (SELECT * FROM base WHERE reversed_at IS NULL),
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

  v_raw_worker_expected := (v_received + v_penalty + v_manual_in) - (v_lent + v_expenses);
  v_worker_expected := GREATEST(v_raw_worker_expected, 0);
  v_day_net := v_raw_worker_expected - v_manual_out;

  -- O valor contado é dinheiro físico AGORA, comparado ao Caixa Disponível atual.
  -- Diferenças de outras datas nunca viram falta/sobra.
  IF v_auto THEN
    v_counted := v_available;
    v_diff := 0;
  ELSE
    IF p_counted IS NOT NULL AND p_counted < 0 THEN
      RAISE EXCEPTION 'O valor contado não pode ser negativo.';
    END IF;
    v_counted := COALESCE(p_counted, v_available);
    IF v_counted < 0 THEN
      RAISE EXCEPTION 'O valor contado não pode ser negativo.';
    END IF;
    v_diff := round(v_counted - v_available, 2);
    IF abs(v_diff) > 0.01 AND (p_note IS NULL OR length(trim(p_note)) < 3) THEN
      RAISE EXCEPTION 'Há diferença entre o valor contado e o Caixa Disponível. Escreva uma observação com pelo menos 3 caracteres.';
    END IF;
  END IF;

  v_final := v_base;

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
    expected_closing_balance=v_base,
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
  v_payload := jsonb_set(
    v_payload, '{totals}',
    COALESCE(v_payload->'totals', '{}'::jsonb) || jsonb_build_object(
      'expected_worker_cash', round(v_worker_expected, 2),
      'available_cash_at_close', round(v_base, 2),
      'current_available_cash', round(v_available, 2),
      'historic_close', v_is_historic,
      'after_date_net', round(COALESCE((v_basis->>'after_net')::numeric, 0), 2),
      'other_dates_difference', v_other_dates,
      'counted_cash', round(v_counted, 2),
      'final_cash', round(v_final, 2),
      'difference', round(v_diff, 2),
      'raw_worker_expected', round(v_raw_worker_expected, 2),
      'day_net', round(v_day_net, 2)
    ),
    true
  );
  IF v_payload ? 'daily_summary' THEN
    v_payload := jsonb_set(
      v_payload, '{daily_summary}',
      COALESCE(v_payload->'daily_summary', '{}'::jsonb) || jsonb_build_object(
        'cashExpectedForClosing', round(v_base, 2)
      ),
      true
    );
  END IF;

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
      'raw_worker_expected',v_raw_worker_expected,
      'expected_worker_cash',v_worker_expected,
      'day_net',v_day_net,
      'historic_close', v_is_historic,
      'after_date_net', COALESCE((v_basis->>'after_net')::numeric, 0),
      'other_dates_difference', v_other_dates,
      'available_cash_at_close',v_base,
      'current_available_cash',v_available,
      'counted',v_counted,'difference',v_diff,
      'final_available',v_final,'events',v_events,'close_origin',p_origin
    ),
    p_note, v_worker);

  RETURN jsonb_build_object('cash_id', p_daily_cash_id, 'version', v_version, 'close_origin', p_origin);
END;
$function$;

REVOKE ALL ON FUNCTION public._close_daily_cash_core(uuid, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._close_daily_cash_core(uuid, numeric, text, text, uuid) TO service_role;