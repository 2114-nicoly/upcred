-- ============================================================
-- FECHAMENTO AUTOMÁTICO: saneamento legado + manutenção contínua
-- ============================================================

-- 1) Nova origem de fechamento
ALTER TABLE public.daily_cash DROP CONSTRAINT IF EXISTS daily_cash_close_origin_check;
ALTER TABLE public.daily_cash ADD CONSTRAINT daily_cash_close_origin_check
  CHECK (close_origin IS NULL OR close_origin = ANY (ARRAY[
    'manual'::text,'automatic_opened'::text,'automatic_not_opened'::text,'legacy_auto_reconciliation'::text
  ]));

-- 2) Monitoramento em auto_close_settings
ALTER TABLE public.auto_close_settings ADD COLUMN IF NOT EXISTS last_run_at timestamptz;
ALTER TABLE public.auto_close_settings ADD COLUMN IF NOT EXISTS last_success_at timestamptz;
ALTER TABLE public.auto_close_settings ADD COLUMN IF NOT EXISTS last_closed_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.auto_close_settings ADD COLUMN IF NOT EXISTS last_failed_count integer NOT NULL DEFAULT 0;

-- 3) Falhas: resolução e nova tentativa
ALTER TABLE public.auto_close_failures ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE public.auto_close_failures ADD COLUMN IF NOT EXISTS next_retry_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public._record_auto_close_failure(
  p_date date, p_worker uuid, p_admin uuid, p_cash_id uuid, p_message text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_rows int;
BEGIN
  UPDATE public.auto_close_failures
     SET attempt_count = attempt_count + 1,
         last_attempt_at = now(),
         next_retry_at = now() + interval '5 minutes',
         resolved_at = NULL,
         error_message = p_message,
         daily_cash_id = COALESCE(p_cash_id, daily_cash_id)
   WHERE cash_date = p_date
     AND admin_id IS NOT DISTINCT FROM p_admin
     AND worker_id IS NOT DISTINCT FROM p_worker;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    INSERT INTO public.auto_close_failures (cash_date, worker_id, admin_id, daily_cash_id, error_message, next_retry_at)
    VALUES (p_date, p_worker, p_admin, p_cash_id, p_message, now() + interval '5 minutes');
  END IF;
END $fn$;

REVOKE ALL ON FUNCTION public._record_auto_close_failure(date, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._record_auto_close_failure(date, uuid, uuid, uuid, text) TO service_role;

-- Só resolve quando fechamento E snapshot existem juntos
CREATE OR REPLACE FUNCTION public._resolve_auto_close_failure(
  p_date date, p_worker uuid, p_admin uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.daily_cash dc
     WHERE dc.cash_date = p_date
       AND dc.admin_id = p_admin
       AND dc.worker_id IS NOT DISTINCT FROM p_worker
       AND dc.status = 'closed'
       AND EXISTS (SELECT 1 FROM public.daily_cash_snapshots s WHERE s.daily_cash_id = dc.id)
  ) INTO v_ok;

  IF v_ok THEN
    UPDATE public.auto_close_failures
       SET resolved_at = now(), next_retry_at = now()
     WHERE cash_date = p_date
       AND admin_id IS NOT DISTINCT FROM p_admin
       AND worker_id IS NOT DISTINCT FROM p_worker
       AND resolved_at IS NULL;
  END IF;
  RETURN v_ok;
END $fn$;

REVOKE ALL ON FUNCTION public._resolve_auto_close_failure(date, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._resolve_auto_close_failure(date, uuid, uuid) TO service_role;

-- 4) Fechamento legado: histórico incompleto, somente dados imutáveis do dia
CREATE OR REPLACE FUNCTION public._legacy_close_daily_cash(p_daily_cash_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  dc record;
  v_date date; v_worker uuid; v_admin uuid;
  v_worker_admin uuid;
  v_received numeric := 0; v_penalty numeric := 0; v_lent numeric := 0;
  v_manual_in numeric := 0; v_manual_out numeric := 0; v_expenses numeric := 0;
  v_in numeric := 0; v_out numeric := 0;
  v_not_paid int := 0; v_events int := 0;
  v_events_json jsonb; v_mov_json jsonb; v_np_json jsonb;
  v_version int; v_payload jsonb;
BEGIN
  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id FOR UPDATE;
  IF dc.id IS NULL THEN
    RAISE EXCEPTION 'caixa não encontrado para reconciliação';
  END IF;
  IF dc.admin_id IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa e o trabalhador deste caixa. O fechamento foi cancelado.';
  END IF;

  v_date := dc.cash_date; v_worker := dc.worker_id; v_admin := dc.admin_id;

  IF v_worker IS NOT NULL THEN
    SELECT parent_admin_id INTO v_worker_admin FROM public.workers WHERE id = v_worker;
    IF v_worker_admin IS NULL OR v_worker_admin IS DISTINCT FROM v_admin THEN
      RAISE EXCEPTION 'Trabalhador não pertence a esta empresa. O fechamento foi cancelado.';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_admin::text || ':' || COALESCE(v_worker::text,'-') || ':' || v_date::text, 0)
  );

  -- idempotência: nunca reprocessa nem sobrescreve histórico existente
  IF dc.status = 'closed'
     OR EXISTS (SELECT 1 FROM public.daily_cash_snapshots s WHERE s.daily_cash_id = dc.id) THEN
    RETURN jsonb_build_object('already_closed', true, 'cash_id', dc.id);
  END IF;

  WITH ev AS (
    SELECT * FROM public.daily_events
     WHERE cash_date = v_date
       AND reversed_at IS NULL
       AND event_type NOT IN ('emprestimo_importado','renovacao_absorvida','ajuste_fechamento','caixa_aberto','caixa_fechado')
       AND worker_id IS NOT DISTINCT FROM v_worker
       AND admin_id = v_admin
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

  SELECT COALESCE(jsonb_agg(to_jsonb(de) ORDER BY de.created_at), '[]'::jsonb) INTO v_events_json
    FROM public.daily_events de
   WHERE de.cash_date = v_date AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin;

  SELECT COALESCE(jsonb_agg(to_jsonb(cm) ORDER BY cm.created_at), '[]'::jsonb) INTO v_mov_json
    FROM public.cash_movements cm
   WHERE cm.cash_date = v_date AND cm.worker_id IS NOT DISTINCT FROM v_worker AND cm.admin_id = v_admin;

  SELECT COALESCE(jsonb_agg(to_jsonb(nm) ORDER BY nm.created_at), '[]'::jsonb) INTO v_np_json
    FROM public.not_paid_marks nm
   WHERE nm.mark_date = v_date AND nm.worker_id IS NOT DISTINCT FROM v_worker AND nm.admin_id = v_admin;

  UPDATE public.daily_cash SET
    status = 'closed',
    total_in = v_in, total_out = v_out,
    total_received = v_received, total_penalty_received = v_penalty,
    total_lent = v_lent,
    total_manual_in = v_manual_in, total_manual_out = v_manual_out,
    total_not_paid_count = v_not_paid,
    total_items_treated = v_events,
    total_events_count = v_events,
    expected_closing_balance = COALESCE(dc.opening_balance,0)
      + ((v_received + v_penalty + v_manual_in) - (v_lent + v_manual_out + v_expenses)),
    counted_closing_balance = NULL,
    closing_difference = NULL,
    closing_note = 'Este fechamento antigo não possui histórico congelado completo',
    close_origin = 'legacy_auto_reconciliation',
    closed_at = now(), closed_by = NULL
  WHERE id = p_daily_cash_id;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM public.daily_cash_snapshots WHERE daily_cash_id = p_daily_cash_id;

  v_payload := jsonb_build_object(
    'historical_complete', false,
    'snapshot_kind', 'legacy_incomplete',
    'warning', 'Este fechamento antigo não possui histórico congelado completo',
    'close_origin', 'legacy_auto_reconciliation',
    'cash_date', v_date,
    'worker_id', v_worker,
    'admin_id', v_admin,
    'daily_cash', to_jsonb(dc),
    'totals', jsonb_build_object(
      'opening_balance', COALESCE(dc.opening_balance,0),
      'received', v_received,
      'penalty_received', v_penalty,
      'lent', v_lent,
      'manual_in', v_manual_in,
      'manual_out', v_manual_out,
      'expenses', v_expenses,
      'total_in', v_in,
      'total_out', v_out,
      'not_paid_count', v_not_paid,
      'events_count', v_events
    ),
    'events', v_events_json,
    'cash_movements', v_mov_json,
    'not_paid_marks', v_np_json
  );

  INSERT INTO public.daily_cash_snapshots (
    daily_cash_id, cash_date, worker_id, admin_id,
    closed_at, closed_by, version, reopen_reason, payload
  ) VALUES (
    p_daily_cash_id, v_date, v_worker, v_admin,
    now(), NULL, v_version, NULL, v_payload
  );

  PERFORM public.log_audit('fechar_caixa','cash',p_daily_cash_id,NULL,
    jsonb_build_object('cash_date', v_date, 'close_origin','legacy_auto_reconciliation',
                       'historical_complete', false),
    'Caixa antigo fechado automaticamente com histórico incompleto', v_worker);

  RETURN jsonb_build_object('cash_id', p_daily_cash_id, 'close_origin', 'legacy_auto_reconciliation');
END $fn$;

REVOKE ALL ON FUNCTION public._legacy_close_daily_cash(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._legacy_close_daily_cash(uuid) TO service_role;

-- 5) Saneamento único, idempotente e em lotes
CREATE OR REPLACE FUNCTION public.reconcile_legacy_open_cash(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  r record; v_closed int := 0; v_failed int := 0;
BEGIN
  FOR r IN
    SELECT dc.id, dc.cash_date, dc.worker_id, dc.admin_id
      FROM public.daily_cash dc
     WHERE dc.status = 'open'
       AND dc.cash_date < (v_today - 1)
       AND dc.admin_id IS NOT NULL
     ORDER BY dc.cash_date
     LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  LOOP
    BEGIN
      PERFORM public._legacy_close_daily_cash(r.id);
      v_closed := v_closed + 1;
      PERFORM public._resolve_auto_close_failure(r.cash_date, r.worker_id, r.admin_id);
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public._record_auto_close_failure(r.cash_date, r.worker_id, r.admin_id, r.id, SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('reconciled', v_closed, 'failed', v_failed);
END $fn$;

REVOKE ALL ON FUNCTION public.reconcile_legacy_open_cash(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_legacy_open_cash(integer) TO service_role;

-- 6) Rotina permanente única
CREATE OR REPLACE FUNCTION public.auto_close_cash_maintenance()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_yesterday date := ((now() AT TIME ZONE 'America/Sao_Paulo')::date) - 1;
  v_from date := public.auto_close_enabled_from();
  r record; res jsonb;
  v_closed int := 0; v_created int := 0; v_legacy int := 0; v_failed int := 0;
BEGIN
  UPDATE public.auto_close_settings SET last_run_at = now(), updated_at = now();

  -- 6.1 caixas anteriores a ontem que continuam abertos: modo legado
  FOR r IN
    SELECT dc.id, dc.cash_date, dc.worker_id, dc.admin_id
      FROM public.daily_cash dc
     WHERE dc.status = 'open' AND dc.cash_date < v_yesterday AND dc.admin_id IS NOT NULL
     ORDER BY dc.cash_date
     LIMIT 200
  LOOP
    BEGIN
      PERFORM public._legacy_close_daily_cash(r.id);
      v_legacy := v_legacy + 1;
      PERFORM public._resolve_auto_close_failure(r.cash_date, r.worker_id, r.admin_id);
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public._record_auto_close_failure(r.cash_date, r.worker_id, r.admin_id, r.id, SQLERRM);
    END;
  END LOOP;

  -- 6.2 ontem: fechamento completo (aberto ou nunca aberto)
  IF v_from IS NOT NULL AND v_yesterday >= v_from THEN
    FOR r IN
      SELECT dc.worker_id, dc.admin_id
        FROM public.daily_cash dc
       WHERE dc.cash_date = v_yesterday AND dc.status = 'open' AND dc.admin_id IS NOT NULL
      UNION
      SELECT w.id, w.parent_admin_id
        FROM public.workers w
        JOIN public.admins a ON a.id = w.parent_admin_id AND a.active = true
       WHERE w.active = true AND w.archived_at IS NULL AND w.parent_admin_id IS NOT NULL
         AND (w.created_at AT TIME ZONE 'America/Sao_Paulo')::date <= v_yesterday
         AND NOT EXISTS (
           SELECT 1 FROM public.company_access_controls cac
            WHERE cac.admin_id = w.parent_admin_id AND cac.manual_status = 'paused')
         AND NOT EXISTS (
           SELECT 1 FROM public.daily_cash dc
            WHERE dc.cash_date = v_yesterday AND dc.worker_id = w.id AND dc.admin_id = w.parent_admin_id)
    LOOP
      BEGIN
        res := public._ensure_previous_daily_cash_closed(v_yesterday, r.worker_id, r.admin_id);
        IF res ? 'close_origin' THEN
          IF res->>'close_origin' = 'automatic_not_opened' THEN v_created := v_created + 1;
          ELSE v_closed := v_closed + 1; END IF;
        END IF;
        PERFORM public._resolve_auto_close_failure(v_yesterday, r.worker_id, r.admin_id);
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed + 1;
        PERFORM public._record_auto_close_failure(v_yesterday, r.worker_id, r.admin_id, NULL, SQLERRM);
      END;
    END LOOP;
  END IF;

  -- 6.3 falhas antigas já resolvidas por outro caminho
  FOR r IN
    SELECT f.cash_date, f.worker_id, f.admin_id
      FROM public.auto_close_failures f
     WHERE f.resolved_at IS NULL AND f.cash_date < v_today
     LIMIT 500
  LOOP
    PERFORM public._resolve_auto_close_failure(r.cash_date, r.worker_id, r.admin_id);
  END LOOP;

  UPDATE public.auto_close_settings
     SET last_success_at = CASE WHEN v_failed = 0 THEN now() ELSE last_success_at END,
         last_closed_count = v_closed + v_created + v_legacy,
         last_failed_count = v_failed,
         updated_at = now();

  RETURN jsonb_build_object(
    'cash_date', v_yesterday,
    'closed', v_closed, 'created_closed', v_created,
    'legacy_reconciled', v_legacy, 'failed', v_failed
  );
END $fn$;

REVOKE ALL ON FUNCTION public.auto_close_cash_maintenance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_close_cash_maintenance() TO service_role;

-- 7) Abertura de hoje: nenhum caixa anterior pode continuar aberto
CREATE OR REPLACE FUNCTION public._scope_oldest_open_cash_date(p_worker uuid, p_admin uuid, p_before date)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT MIN(dc.cash_date) FROM public.daily_cash dc
   WHERE dc.status = 'open'
     AND dc.cash_date < p_before
     AND dc.admin_id = p_admin
     AND dc.worker_id IS NOT DISTINCT FROM p_worker
$fn$;

REVOKE ALL ON FUNCTION public._scope_oldest_open_cash_date(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._scope_oldest_open_cash_date(uuid, uuid, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.open_daily_cash(p_cash_date date, p_worker_id uuid DEFAULT NULL::uuid)
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
  v_today date;
  v_pending date;
  v_reason text;
  r record;
BEGIN
  v_today := (now() AT TIME ZONE 'America/Sao_Paulo')::date;

  IF p_cash_date IS NULL THEN
    RAISE EXCEPTION 'Data do caixa inválida.';
  END IF;
  IF p_cash_date > v_today THEN
    RAISE EXCEPTION 'Não é permitido abrir caixa em data futura. Abra o caixa na própria data.';
  END IF;
  IF p_cash_date < v_today THEN
    RAISE EXCEPTION 'Não é permitido abrir um caixa antigo. Utilize o processo de solicitação de reabertura.';
  END IF;

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

  -- Qualquer caixa anterior aberto deste mesmo escopo precisa estar finalizado
  IF v_admin IS NOT NULL THEN
    v_pending := public._scope_oldest_open_cash_date(v_worker, v_admin, v_today);

    IF v_pending IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM public.daily_cash dc
       WHERE dc.cash_date = (v_today - 1) AND dc.admin_id = v_admin
         AND dc.worker_id IS NOT DISTINCT FROM v_worker
    ) THEN
      -- tenta a manutenção do próprio escopo (ontem completo, anteriores em modo legado)
      FOR r IN
        SELECT dc.id, dc.cash_date FROM public.daily_cash dc
         WHERE dc.status = 'open' AND dc.cash_date < (v_today - 1)
           AND dc.admin_id = v_admin AND dc.worker_id IS NOT DISTINCT FROM v_worker
         ORDER BY dc.cash_date
      LOOP
        BEGIN
          PERFORM public._legacy_close_daily_cash(r.id);
        EXCEPTION WHEN OTHERS THEN
          PERFORM public._record_auto_close_failure(r.cash_date, v_worker, v_admin, r.id, SQLERRM);
        END;
      END LOOP;

      BEGIN
        PERFORM public._ensure_previous_daily_cash_closed(v_today - 1, v_worker, v_admin);
      EXCEPTION WHEN OTHERS THEN
        v_reason := SQLERRM;
        PERFORM public._record_auto_close_failure(v_today - 1, v_worker, v_admin, NULL, v_reason);
      END;
    END IF;

    v_pending := public._scope_oldest_open_cash_date(v_worker, v_admin, v_today);
    IF v_pending IS NOT NULL THEN
      RAISE EXCEPTION 'O caixa de % ainda está aberto e não pôde ser finalizado automaticamente. O caixa de hoje não foi aberto. Motivo: %',
        to_char(v_pending, 'DD/MM/YYYY'),
        COALESCE(v_reason, 'finalize ou solicite a reabertura desse dia');
    END IF;
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

  IF v_worker IS NOT NULL THEN
    SELECT COALESCE(available_cash, 0) INTO v_opening
      FROM public.cash_balance WHERE worker_id = v_worker LIMIT 1;
  ELSE
    SELECT COALESCE(available_cash, 0) INTO v_opening
      FROM public.cash_balance WHERE worker_id IS NULL AND admin_id = v_admin LIMIT 1;
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

-- 8) Cron único a cada 5 minutos
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $do$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job
            WHERE jobname = 'auto-close-daily-cash'
               OR command ILIKE '%auto_close_previous_day%'
               OR command ILIKE '%auto_close_cash_maintenance%'
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;

  PERFORM cron.schedule('auto-close-daily-cash', '*/5 * * * *', 'SELECT public.auto_close_cash_maintenance();');

  IF (SELECT count(*) FROM cron.job WHERE jobname = 'auto-close-daily-cash') <> 1 THEN
    RAISE EXCEPTION 'job auto-close-daily-cash duplicado ou ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-close-daily-cash' AND active) THEN
    RAISE EXCEPTION 'job auto-close-daily-cash inativo';
  END IF;
END $do$;

-- 9) Saneamento único imediato dos caixas antigos
SELECT public.reconcile_legacy_open_cash(500);