-- ============================================================
-- v60 — Garantia dos fechamentos daqui para frente (data de corte estrita)
-- Não altera, reconstrói ou apaga caixas/snapshots anteriores à data de corte.
-- ============================================================

-- 1) Data de corte -------------------------------------------------------
ALTER TABLE public.auto_close_settings
  ADD COLUMN IF NOT EXISTS strict_snapshot_from_date date;

UPDATE public.auto_close_settings
   SET strict_snapshot_from_date = COALESCE(
         strict_snapshot_from_date, (now() AT TIME ZONE 'America/Sao_Paulo')::date),
       updated_at = now()
 WHERE singleton;

INSERT INTO public.auto_close_settings (singleton, enabled_from_date, strict_snapshot_from_date)
SELECT true, (now() AT TIME ZONE 'America/Sao_Paulo')::date, (now() AT TIME ZONE 'America/Sao_Paulo')::date
WHERE NOT EXISTS (SELECT 1 FROM public.auto_close_settings WHERE singleton);

CREATE OR REPLACE FUNCTION public.strict_snapshot_from()
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT strict_snapshot_from_date FROM public.auto_close_settings WHERE singleton LIMIT 1
$fn$;

REVOKE ALL ON FUNCTION public.strict_snapshot_from() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.strict_snapshot_from() TO authenticated, service_role;

-- Snapshot completo e válido do caixa (com pendentes congelados)
CREATE OR REPLACE FUNCTION public._daily_cash_snapshot_ok(p_daily_cash_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.daily_cash_snapshots s
     WHERE s.daily_cash_id = p_daily_cash_id
       AND COALESCE((s.payload->>'historical_complete')::boolean, true) = true
       AND (s.payload->>'snapshot_kind') IS DISTINCT FROM 'legacy_incomplete'
       AND jsonb_typeof(s.payload->'pending_installments') = 'array'
       AND (s.payload->'scope'->>'admin_id') IS NOT NULL
  )
$fn$;

REVOKE ALL ON FUNCTION public._daily_cash_snapshot_ok(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._daily_cash_snapshot_ok(uuid) TO authenticated, service_role;

-- 2) Modo legado proibido a partir da data de corte -----------------------
CREATE OR REPLACE FUNCTION public._legacy_close_daily_cash(p_daily_cash_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  dc record; v_worker_admin uuid; v_version int; v_payload jsonb; t jsonb;
  v_strict date := public.strict_snapshot_from();
BEGIN
  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id FOR UPDATE;
  IF dc.id IS NULL THEN RAISE EXCEPTION 'caixa não encontrado para reconciliação'; END IF;
  IF dc.admin_id IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa e o trabalhador deste caixa. O fechamento foi cancelado.';
  END IF;
  IF v_strict IS NOT NULL AND dc.cash_date >= v_strict THEN
    RAISE EXCEPTION 'Esta data exige fechamento completo com registro histórico. Histórico incompleto não é permitido.';
  END IF;
  IF dc.worker_id IS NOT NULL THEN
    SELECT parent_admin_id INTO v_worker_admin FROM public.workers WHERE id = dc.worker_id;
    IF v_worker_admin IS NULL OR v_worker_admin IS DISTINCT FROM dc.admin_id THEN
      RAISE EXCEPTION 'Trabalhador não pertence a esta empresa. O fechamento foi cancelado.';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(dc.admin_id::text || ':' || COALESCE(dc.worker_id::text,'-') || ':' || dc.cash_date::text, 0)
  );

  IF dc.status = 'closed'
     OR EXISTS (SELECT 1 FROM public.daily_cash_snapshots s WHERE s.daily_cash_id = dc.id) THEN
    RETURN jsonb_build_object('already_closed', true, 'cash_id', dc.id);
  END IF;

  v_payload := public._legacy_snapshot_payload(p_daily_cash_id);
  t := v_payload->'totals';

  UPDATE public.daily_cash SET
    status = 'closed',
    total_in = (t->>'total_in')::numeric,
    total_out = (t->>'total_out')::numeric,
    total_received = (t->>'received')::numeric,
    total_penalty_received = (t->>'penalty')::numeric,
    total_lent = (t->>'lent')::numeric,
    total_manual_in = (t->>'manual_in')::numeric,
    total_manual_out = (t->>'manual_out')::numeric,
    total_not_paid_count = (t->>'not_paid_count')::int,
    total_items_treated = (t->>'events_count')::int,
    total_events_count = (t->>'events_count')::int,
    expected_closing_balance = (t->>'expected_worker_cash')::numeric,
    counted_closing_balance = NULL,
    closing_difference = NULL,
    closing_note = 'Este fechamento antigo não possui histórico congelado completo',
    close_origin = 'legacy_auto_reconciliation',
    closed_at = now(), closed_by = NULL
  WHERE id = p_daily_cash_id;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM public.daily_cash_snapshots WHERE daily_cash_id = p_daily_cash_id;

  INSERT INTO public.daily_cash_snapshots (
    daily_cash_id, cash_date, worker_id, admin_id,
    closed_at, closed_by, version, reopen_reason, payload
  ) VALUES (
    p_daily_cash_id, dc.cash_date, dc.worker_id, dc.admin_id,
    now(), NULL, v_version, NULL, v_payload
  );

  PERFORM public.log_audit('fechar_caixa','cash',p_daily_cash_id,NULL,
    jsonb_build_object('cash_date', dc.cash_date, 'close_origin','legacy_auto_reconciliation',
                       'historical_complete', false),
    'Caixa antigo fechado automaticamente com histórico incompleto', dc.worker_id);

  RETURN jsonb_build_object('cash_id', p_daily_cash_id, 'close_origin', 'legacy_auto_reconciliation');
END $fn$;

REVOKE ALL ON FUNCTION public._legacy_close_daily_cash(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._legacy_close_daily_cash(uuid) TO service_role;

-- 3) Fechamento estrito de qualquer data pendente -------------------------
CREATE OR REPLACE FUNCTION public._ensure_daily_cash_closed_strict(
  p_date date, p_worker_id uuid, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_strict date := public.strict_snapshot_from();
  v_id uuid; v_status text; v_opening numeric; v_worker_admin uuid;
  v_active boolean; v_origin text;
BEGIN
  IF p_date IS NULL THEN RAISE EXCEPTION 'Data do caixa inválida.'; END IF;
  IF p_admin_id IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa e o trabalhador deste caixa. O fechamento foi cancelado.';
  END IF;
  IF p_date >= v_today THEN
    RAISE EXCEPTION 'Somente datas anteriores a hoje podem ser finalizadas automaticamente.';
  END IF;
  IF v_strict IS NULL OR p_date < v_strict THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'before_strict_from');
  END IF;

  IF p_worker_id IS NOT NULL THEN
    SELECT parent_admin_id, (active AND archived_at IS NULL)
      INTO v_worker_admin, v_active
      FROM public.workers WHERE id = p_worker_id;
    IF v_worker_admin IS NULL OR v_worker_admin IS DISTINCT FROM p_admin_id THEN
      RAISE EXCEPTION 'Trabalhador não pertence a esta empresa. O fechamento foi cancelado.';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_admin_id::text || ':' || COALESCE(p_worker_id::text,'-') || ':' || p_date::text, 0)
  );

  SELECT id, status INTO v_id, v_status FROM public.daily_cash
   WHERE cash_date = p_date
     AND admin_id = p_admin_id
     AND worker_id IS NOT DISTINCT FROM p_worker_id
   LIMIT 1;

  IF v_id IS NOT NULL AND v_status = 'closed' THEN
    IF public._daily_cash_snapshot_ok(v_id) THEN
      RETURN jsonb_build_object('already_closed', true, 'cash_id', v_id);
    END IF;
    -- Integridade: dia fechado sem registro histórico válido → refazer
    UPDATE public.daily_cash
       SET status = 'open', closed_at = NULL, closed_by = NULL,
           counted_closing_balance = NULL, closing_difference = NULL,
           close_origin = NULL
     WHERE id = v_id;
    v_status := 'open';
  END IF;

  IF v_id IS NULL THEN
    IF p_worker_id IS NULL OR COALESCE(v_active, false) = false THEN
      RETURN jsonb_build_object('skipped', true, 'reason', 'no_cash_to_close');
    END IF;

    SELECT cb.available_cash INTO v_opening
      FROM public.cash_balance cb
     WHERE cb.worker_id = p_worker_id AND cb.admin_id = p_admin_id
     LIMIT 1;
    IF v_opening IS NULL THEN
      RAISE EXCEPTION 'Saldo do trabalhador não encontrado. O fechamento automático foi cancelado.';
    END IF;

    INSERT INTO public.daily_cash (cash_date, worker_id, admin_id, status, opening_balance, user_id)
    VALUES (p_date, p_worker_id, p_admin_id, 'open', GREATEST(v_opening, 0), NULL)
    RETURNING id INTO v_id;
    v_origin := 'automatic_not_opened';
  ELSE
    v_origin := 'automatic_opened';
  END IF;

  PERFORM public._close_daily_cash_core(
    v_id, NULL,
    CASE WHEN v_origin = 'automatic_not_opened'
      THEN 'Caixa não foi aberto e foi fechado automaticamente' ELSE NULL END,
    v_origin, NULL);

  IF NOT public._daily_cash_snapshot_ok(v_id) THEN
    RAISE EXCEPTION 'O fechamento não gerou o registro histórico obrigatório. O caixa continua aberto.';
  END IF;

  RETURN jsonb_build_object('cash_id', v_id, 'close_origin', v_origin);
END $fn$;

REVOKE ALL ON FUNCTION public._ensure_daily_cash_closed_strict(date, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._ensure_daily_cash_closed_strict(date, uuid, uuid) TO service_role;

-- compatibilidade: rotina antiga delega para a estrita (sem limite de "ontem")
CREATE OR REPLACE FUNCTION public._ensure_previous_daily_cash_closed(
  p_date date, p_worker_id uuid, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN public._ensure_daily_cash_closed_strict(p_date, p_worker_id, p_admin_id);
END $fn$;

REVOKE ALL ON FUNCTION public._ensure_previous_daily_cash_closed(date, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._ensure_previous_daily_cash_closed(date, uuid, uuid) TO service_role;

-- 4) Datas pendentes de um escopo (ordem cronológica) ---------------------
CREATE OR REPLACE FUNCTION public._scope_pending_cash_dates(
  p_worker uuid, p_admin uuid, p_before date)
RETURNS TABLE(cash_date date) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH strict_from AS (SELECT public.strict_snapshot_from() AS sd),
  existing AS (
    SELECT dc.cash_date, dc.status, dc.id
      FROM public.daily_cash dc
     WHERE dc.cash_date < p_before
       AND dc.admin_id = p_admin
       AND dc.worker_id IS NOT DISTINCT FROM p_worker
  ),
  opened AS (
    SELECT e.cash_date FROM existing e WHERE e.status = 'open'
  ),
  broken AS (
    SELECT e.cash_date FROM existing e, strict_from sf
     WHERE e.status = 'closed' AND sf.sd IS NOT NULL AND e.cash_date >= sf.sd
       AND NOT public._daily_cash_snapshot_ok(e.id)
  ),
  missing AS (
    SELECT gs.day::date AS cash_date
      FROM public.workers w, strict_from sf
      CROSS JOIN LATERAL generate_series(
        GREATEST(sf.sd, (w.created_at AT TIME ZONE 'America/Sao_Paulo')::date),
        p_before - 1, interval '1 day') AS gs(day)
     WHERE p_worker IS NOT NULL AND w.id = p_worker AND w.parent_admin_id = p_admin
       AND sf.sd IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM existing e WHERE e.cash_date = gs.day::date)
  )
  SELECT cash_date FROM (
    SELECT cash_date FROM opened
    UNION SELECT cash_date FROM broken
    UNION SELECT cash_date FROM missing
  ) s ORDER BY cash_date
$fn$;

REVOKE ALL ON FUNCTION public._scope_pending_cash_dates(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._scope_pending_cash_dates(uuid, uuid, date) TO authenticated, service_role;

-- 5) Manutenção automática: todas as datas pendentes, em ordem ------------
CREATE OR REPLACE FUNCTION public.auto_close_cash_maintenance()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_strict date := public.strict_snapshot_from();
  r record; d record; res jsonb;
  v_closed int := 0; v_created int := 0; v_legacy int := 0; v_failed int := 0;
BEGIN
  UPDATE public.auto_close_settings SET last_run_at = now(), updated_at = now();

  -- 5.1 saneamento histórico: somente ANTES da data de corte
  FOR r IN
    SELECT dc.id, dc.cash_date, dc.worker_id, dc.admin_id
      FROM public.daily_cash dc
     WHERE dc.status = 'open' AND dc.cash_date < v_today
       AND v_strict IS NOT NULL AND dc.cash_date < v_strict
       AND dc.admin_id IS NOT NULL
     ORDER BY dc.cash_date LIMIT 200
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

  IF v_strict IS NULL THEN
    RETURN jsonb_build_object('strict_from', NULL, 'legacy_reconciled', v_legacy, 'failed', v_failed);
  END IF;

  -- 5.2 escopos ativos: processa TODAS as datas pendentes em ordem cronológica
  FOR r IN
    SELECT w.id AS worker_id, w.parent_admin_id AS admin_id
      FROM public.workers w
      JOIN public.admins a ON a.id = w.parent_admin_id AND a.active = true
     WHERE w.active = true AND w.archived_at IS NULL AND w.parent_admin_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.company_access_controls cac
          WHERE cac.admin_id = w.parent_admin_id AND cac.manual_status = 'paused')
    UNION
    SELECT dc.worker_id, dc.admin_id
      FROM public.daily_cash dc
     WHERE dc.admin_id IS NOT NULL AND dc.cash_date >= v_strict AND dc.cash_date < v_today
       AND (dc.status = 'open' OR NOT public._daily_cash_snapshot_ok(dc.id))
  LOOP
    FOR d IN
      SELECT * FROM public._scope_pending_cash_dates(r.worker_id, r.admin_id, v_today)
       WHERE cash_date >= v_strict
       ORDER BY cash_date
       LIMIT 60
    LOOP
      BEGIN
        res := public._ensure_daily_cash_closed_strict(d.cash_date, r.worker_id, r.admin_id);
        IF res ? 'close_origin' THEN
          IF res->>'close_origin' = 'automatic_not_opened' THEN v_created := v_created + 1;
          ELSE v_closed := v_closed + 1; END IF;
        END IF;
        PERFORM public._resolve_auto_close_failure(d.cash_date, r.worker_id, r.admin_id);
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed + 1;
        PERFORM public._record_auto_close_failure(d.cash_date, r.worker_id, r.admin_id, NULL, SQLERRM);
        EXIT; -- não avança para datas posteriores deste escopo
      END;
    END LOOP;
  END LOOP;

  -- 5.3 falhas já resolvidas por outro caminho
  FOR r IN
    SELECT f.cash_date, f.worker_id, f.admin_id
      FROM public.auto_close_failures f
     WHERE f.resolved_at IS NULL AND f.cash_date < v_today AND f.admin_id IS NOT NULL
     ORDER BY f.cash_date LIMIT 500
  LOOP
    PERFORM public._resolve_auto_close_failure(r.cash_date, r.worker_id, r.admin_id);
  END LOOP;

  UPDATE public.auto_close_settings
     SET last_success_at = CASE WHEN v_failed = 0 THEN now() ELSE last_success_at END,
         last_closed_count = v_closed + v_created + v_legacy,
         last_failed_count = v_failed,
         updated_at = now();

  RETURN jsonb_build_object(
    'strict_from', v_strict, 'closed', v_closed, 'created_closed', v_created,
    'legacy_reconciled', v_legacy, 'failed', v_failed
  );
END $fn$;

REVOKE ALL ON FUNCTION public.auto_close_cash_maintenance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_close_cash_maintenance() TO service_role;

-- 6) Abertura do caixa ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_daily_cash(p_cash_date date, p_worker_id uuid DEFAULT NULL::uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_worker uuid; v_admin uuid; v_caller_admin uuid;
  v_is_admin boolean; v_is_super boolean;
  v_id uuid; v_status text; v_opening numeric := 0;
  v_target_worker_admin uuid; v_today date; v_strict date;
  v_reason text; v_pending date; v_failed_date date; d record;
BEGIN
  v_today := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_strict := public.strict_snapshot_from();

  IF p_cash_date IS NULL THEN RAISE EXCEPTION 'Data do caixa inválida.'; END IF;
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
    IF v_target_worker_admin IS NULL THEN RAISE EXCEPTION 'trabalhador não encontrado'; END IF;
    IF NOT v_is_super AND v_target_worker_admin IS DISTINCT FROM v_caller_admin THEN
      RAISE EXCEPTION 'trabalhador não pertence à sua equipe';
    END IF;
    v_worker := p_worker_id;
    v_admin  := v_target_worker_admin;
  ELSE
    v_worker := public.get_worker_id(auth.uid());
    v_admin  := v_caller_admin;
    IF v_worker IS NOT NULL THEN
      SELECT parent_admin_id INTO v_admin FROM public.workers WHERE id = v_worker;
    END IF;
  END IF;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'usuário sem escopo (empresa) para abrir caixa';
  END IF;

  -- 6.1 tenta resolver TODAS as pendências anteriores, em ordem cronológica
  FOR d IN
    SELECT dc.id, dc.cash_date FROM public.daily_cash dc
     WHERE dc.status = 'open' AND dc.cash_date < v_today
       AND v_strict IS NOT NULL AND dc.cash_date < v_strict
       AND dc.admin_id = v_admin AND dc.worker_id IS NOT DISTINCT FROM v_worker
     ORDER BY dc.cash_date
  LOOP
    BEGIN
      PERFORM public._legacy_close_daily_cash(d.id);
    EXCEPTION WHEN OTHERS THEN
      v_reason := SQLERRM;
      PERFORM public._record_auto_close_failure(d.cash_date, v_worker, v_admin, d.id, SQLERRM);
    END;
  END LOOP;

  IF v_strict IS NOT NULL THEN
    FOR d IN
      SELECT * FROM public._scope_pending_cash_dates(v_worker, v_admin, v_today)
       WHERE cash_date >= v_strict ORDER BY cash_date
    LOOP
      BEGIN
        PERFORM public._ensure_daily_cash_closed_strict(d.cash_date, v_worker, v_admin);
        PERFORM public._resolve_auto_close_failure(d.cash_date, v_worker, v_admin);
      EXCEPTION WHEN OTHERS THEN
        v_reason := SQLERRM;
        PERFORM public._record_auto_close_failure(d.cash_date, v_worker, v_admin, NULL, SQLERRM);
        EXIT;
      END;
    END LOOP;
  END IF;

  -- 6.2 revalida TODOS os bloqueios
  v_pending := public._scope_oldest_open_cash_date(v_worker, v_admin, v_today);
  IF v_pending IS NULL THEN
    SELECT MIN(cash_date) INTO v_pending
      FROM public._scope_pending_cash_dates(v_worker, v_admin, v_today);
  END IF;

  SELECT MIN(f.cash_date) INTO v_failed_date FROM public.auto_close_failures f
   WHERE f.resolved_at IS NULL AND f.cash_date < v_today
     AND f.admin_id = v_admin AND f.worker_id IS NOT DISTINCT FROM v_worker;

  v_pending := LEAST(COALESCE(v_pending, v_failed_date), COALESCE(v_failed_date, v_pending));

  IF v_pending IS NOT NULL THEN
    RAISE EXCEPTION 'O caixa de % ainda está pendente e não pôde ser finalizado automaticamente. O caixa de hoje não foi aberto. Motivo: %',
      to_char(v_pending, 'DD/MM/YYYY'),
      COALESCE(v_reason, 'finalize ou solicite a reabertura desse dia');
  END IF;

  -- 6.3 caixa do dia (escopo completo: data + trabalhador + empresa)
  SELECT id, status INTO v_id, v_status FROM public.daily_cash
    WHERE cash_date = p_cash_date
      AND worker_id IS NOT DISTINCT FROM v_worker
      AND admin_id = v_admin
    LIMIT 1;

  IF v_id IS NOT NULL THEN
    IF v_status = 'open' THEN
      RETURN v_id;
    END IF;
    IF v_status IN ('cancelled', 'cancelled_empty', 'void') THEN
      UPDATE public.daily_cash
         SET status = 'open', cancelled_at = NULL, cancelled_by = NULL,
             cancellation_reason = NULL, opened_at = now(), opened_by = auth.uid()
       WHERE id = v_id;
      PERFORM public.log_audit('reabrir_caixa','cash',v_id,
        jsonb_build_object('status', v_status),
        jsonb_build_object('status','open','cash_date',p_cash_date,'action','reopen_after_cancel'),
        'Reabertura após cancelamento vazio', v_worker);
      RETURN v_id;
    END IF;
    RAISE EXCEPTION 'O caixa de hoje já foi fechado. Solicite a reabertura para voltar a movimentar.';
  END IF;

  SELECT COALESCE(available_cash, 0) INTO v_opening
    FROM public.cash_balance
   WHERE worker_id IS NOT DISTINCT FROM v_worker AND admin_id = v_admin
   LIMIT 1;
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

-- 7) Segurança: builder do snapshot é interno ----------------------------
REVOKE ALL ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.build_daily_cash_snapshot_v2_legacy(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_daily_cash_snapshot_v2_legacy(uuid) TO service_role;

-- 8) Cron único a cada 5 minutos -----------------------------------------
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job
     WHERE jobname = 'auto-close-daily-cash' OR command ILIKE '%auto_close_previous_day%';
    PERFORM cron.schedule('auto-close-daily-cash', '*/5 * * * *', 'SELECT public.auto_close_cash_maintenance();');
  END IF;
END $do$;