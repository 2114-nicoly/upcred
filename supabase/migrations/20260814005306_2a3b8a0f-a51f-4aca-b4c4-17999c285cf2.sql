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

  -- Dinheiro esperado com o trabalhador: saídas manuais NÃO entram aqui.
  v_raw_worker_expected := (v_received + v_penalty + v_manual_in) - (v_lent + v_expenses);
  v_worker_expected := GREATEST(v_raw_worker_expected, 0);
  -- Movimento líquido do dia (pode ser negativo) — usado apenas para o caixa final.
  v_day_net := v_raw_worker_expected - v_manual_out;

  IF v_auto THEN
    v_counted := v_worker_expected;
    v_diff := 0;
  ELSE
    IF p_counted IS NOT NULL AND p_counted < 0 THEN
      RAISE EXCEPTION 'O valor contado não pode ser negativo.';
    END IF;
    v_counted := COALESCE(p_counted, v_worker_expected);
    IF v_counted < 0 THEN
      RAISE EXCEPTION 'O valor contado não pode ser negativo.';
    END IF;
    v_diff := v_counted - v_worker_expected;
    IF abs(v_diff) > 0.01 AND (p_note IS NULL OR length(trim(p_note)) < 3) THEN
      RAISE EXCEPTION 'Há diferença entre o valor contado e o esperado. Escreva uma observação com pelo menos 3 caracteres.';
    END IF;
  END IF;

  v_final := v_opening + v_day_net;

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
  -- Garante no snapshot os valores autoritativos do fechamento.
  v_payload := jsonb_set(
    v_payload, '{totals}',
    COALESCE(v_payload->'totals', '{}'::jsonb) || jsonb_build_object(
      'expected_worker_cash', round(v_worker_expected, 2),
      'counted_cash', round(v_counted, 2),
      'final_cash', round(v_final, 2),
      'raw_worker_expected', round(v_raw_worker_expected, 2),
      'day_net', round(v_day_net, 2)
    ),
    true
  );

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
      'counted',v_counted,'difference',v_diff,
      'final_available',v_final,'events',v_events,'close_origin',p_origin
    ),
    p_note, v_worker);

  RETURN jsonb_build_object('cash_id', p_daily_cash_id, 'version', v_version, 'close_origin', p_origin);
END;
$function$;