-- ============================================================
-- v59 — correções: snapshots legados com escopo, totais pair-aware,
-- retentativas reais do fechamento automático e isolamento na abertura.
-- ============================================================

-- 1) Payload legado corrigido (idempotente, somente dados imutáveis da data)
CREATE OR REPLACE FUNCTION public._legacy_snapshot_payload(p_daily_cash_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  dc record;
  v_date date; v_worker uuid; v_admin uuid;
  v_received numeric := 0; v_penalty numeric := 0; v_lent numeric := 0;
  v_manual_in numeric := 0; v_manual_out numeric := 0; v_expenses numeric := 0;
  v_in numeric := 0; v_out numeric := 0;
  v_estornos numeric := 0; v_estornos_count int := 0;
  v_not_paid int := 0; v_events_count int := 0;
  v_events jsonb; v_reversed jsonb; v_mov jsonb; v_np jsonb; v_paid jsonb;
  v_opening numeric := 0; v_expected numeric := 0;
BEGIN
  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id;
  IF dc.id IS NULL THEN
    RAISE EXCEPTION 'caixa não encontrado para snapshot legado';
  END IF;
  v_date := dc.cash_date; v_worker := dc.worker_id; v_admin := dc.admin_id;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'caixa legado sem empresa definida';
  END IF;
  v_opening := COALESCE(dc.opening_balance, 0);

  -- Totais pair-aware: contrapartida anula o original, categoria fica líquida.
  WITH ev AS (
    SELECT de.*,
           (de.reverses_event_id IS NOT NULL OR de.event_type LIKE 'estorno%') AS is_counter,
           EXISTS (
             SELECT 1 FROM public.daily_events c
              WHERE c.reverses_event_id = de.id
                AND c.cash_date = v_date
                AND c.worker_id IS NOT DISTINCT FROM v_worker
                AND c.admin_id = v_admin
           ) AS has_counter
      FROM public.daily_events de
     WHERE de.cash_date = v_date
       AND de.worker_id IS NOT DISTINCT FROM v_worker
       AND de.admin_id = v_admin
       AND de.event_type NOT IN ('emprestimo_importado','renovacao_absorvida','ajuste_fechamento','caixa_aberto','caixa_fechado')
  )
  SELECT
    COALESCE(SUM(CASE WHEN NOT is_counter AND reversed_at IS NULL AND event_type='pagamento' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN NOT is_counter AND reversed_at IS NULL AND event_type='recebimento_multa' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN NOT is_counter AND reversed_at IS NULL AND event_type IN ('emprestimo_novo','renovacao','renegociacao') THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN NOT is_counter AND reversed_at IS NULL AND event_type='entrada_manual' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN NOT is_counter AND reversed_at IS NULL AND event_type='saida_manual' THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN NOT is_counter AND reversed_at IS NULL AND event_type='despesa' THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN reversed_at IS NULL OR has_counter THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN reversed_at IS NULL OR has_counter THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN is_counter THEN ABS(amount_in) + ABS(amount_out) ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN is_counter THEN 1 ELSE 0 END),0)::int,
    COALESCE(SUM(CASE WHEN reversed_at IS NULL AND event_type='nao_pagou' THEN 1 ELSE 0 END),0)::int,
    COALESCE(SUM(CASE WHEN reversed_at IS NULL THEN 1 ELSE 0 END),0)::int
  INTO v_received, v_penalty, v_lent, v_manual_in, v_manual_out, v_expenses,
       v_in, v_out, v_estornos, v_estornos_count, v_not_paid, v_events_count
  FROM ev;

  v_expected := v_opening + (v_received + v_penalty + v_manual_in) - (v_lent + v_manual_out + v_expenses);

  -- events = não estornados (inclui a contrapartida)
  SELECT COALESCE(jsonb_agg(to_jsonb(de) ORDER BY de.created_at DESC), '[]'::jsonb) INTO v_events
    FROM public.daily_events de
   WHERE de.cash_date = v_date AND de.reversed_at IS NULL
     AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin;

  -- reversed_events = somente o original com reversed_at (nunca a contrapartida)
  SELECT COALESCE(jsonb_agg(to_jsonb(de) ORDER BY de.created_at DESC), '[]'::jsonb) INTO v_reversed
    FROM public.daily_events de
   WHERE de.cash_date = v_date AND de.reversed_at IS NOT NULL
     AND de.reverses_event_id IS NULL AND de.event_type NOT LIKE 'estorno%'
     AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin;

  SELECT COALESCE(jsonb_agg(to_jsonb(cm) ORDER BY cm.created_at), '[]'::jsonb) INTO v_mov
    FROM public.cash_movements cm
   WHERE cm.cash_date = v_date AND cm.worker_id IS NOT DISTINCT FROM v_worker AND cm.admin_id = v_admin;

  SELECT COALESCE(jsonb_agg(to_jsonb(nm) ORDER BY nm.created_at), '[]'::jsonb) INTO v_np
    FROM public.not_paid_marks nm
   WHERE nm.mark_date = v_date AND nm.worker_id IS NOT DISTINCT FROM v_worker AND nm.admin_id = v_admin;

  -- paid_groups: SOMENTE metadata congelado do pagamento
  SELECT COALESCE(jsonb_agg(g ORDER BY g->>'createdAt'), '[]'::jsonb) INTO v_paid
  FROM (
    SELECT jsonb_build_object(
      'eventId', de.id,
      'movementId', COALESCE(de.metadata->>'cash_movement_id', de.cash_movement_id::text, ''),
      'clientName', COALESCE(de.metadata->>'client_name', 'Cliente'),
      'clientId', COALESCE(de.metadata->>'client_id', de.client_id::text, ''),
      'loanId', COALESCE(de.metadata->>'loan_id', de.loan_id::text, ''),
      'totalPaid', COALESCE((NULLIF(de.metadata->>'payment_amount',''))::numeric, de.amount_in, 0),
      'createdAt', de.created_at,
      'cashDate', COALESCE(de.metadata->>'cash_date', de.cash_date::text),
      'hasFrozenProgress', (
        NULLIF(de.metadata->>'remaining_balance_before','') IS NOT NULL AND
        NULLIF(de.metadata->>'remaining_balance_after','') IS NOT NULL AND
        de.metadata->>'installment_progress_before' IS NOT NULL AND
        de.metadata->>'installment_progress_after' IS NOT NULL
      ),
      'instAmount', NULLIF(de.metadata->>'installment_amount','')::numeric,
      'installmentCount', NULLIF(de.metadata->>'total_installments','')::numeric,
      'remainingBefore', NULLIF(de.metadata->>'remaining_balance_before','')::numeric,
      'remainingAfter', NULLIF(de.metadata->>'remaining_balance_after','')::numeric,
      'progressBeforeFormatted', de.metadata->>'installment_progress_before',
      'progressAfterFormatted', de.metadata->>'installment_progress_after',
      'installmentIds', '[]'::jsonb
    ) AS g
    FROM public.daily_events de
   WHERE de.cash_date = v_date AND de.reversed_at IS NULL AND de.event_type = 'pagamento'
     AND de.worker_id IS NOT DISTINCT FROM v_worker AND de.admin_id = v_admin
  ) s;

  RETURN jsonb_build_object(
    'version', 1,
    'format_revision', 2,
    'cash_date', v_date,
    'scope', jsonb_build_object('worker_id', v_worker, 'admin_id', v_admin),
    'historical_complete', false,
    'snapshot_kind', 'legacy_incomplete',
    'warning', 'Este fechamento antigo não possui histórico congelado completo',
    'close_origin', 'legacy_auto_reconciliation',
    'closed_at', COALESCE(dc.closed_at, now()),
    'closed_by', jsonb_build_object('id', NULL, 'name', NULL, 'role', NULL),
    'observation', dc.closing_note,
    'totals', jsonb_build_object(
      'opening_balance', v_opening,
      'expected_worker_cash', v_expected,
      'counted_cash', dc.counted_closing_balance,
      'final_cash', v_expected,
      'received', v_received,
      'penalty', v_penalty,
      'manual_in', v_manual_in,
      'manual_out', v_manual_out,
      'expenses', v_expenses,
      'new_loans', 0,
      'renewals', 0,
      'lent', v_lent,
      'total_in', v_in,
      'total_out', v_out,
      'not_paid_count', v_not_paid,
      'events_count', v_events_count,
      'penalty_paid_today', v_penalty,
      'estornos', v_estornos,
      'estornos_count', v_estornos_count
    ),
    'daily_summary', NULL,
    'events', v_events,
    'reversed_events', v_reversed,
    'renewal_events', '[]'::jsonb,
    'client_names', '{}'::jsonb,
    'paid_groups', v_paid,
    'not_paid_marks', v_np,
    'cash_movements', v_mov,
    'new_loans', '[]'::jsonb,
    'expense_breakdown', '{}'::jsonb
  );
END $fn$;

REVOKE ALL ON FUNCTION public._legacy_snapshot_payload(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._legacy_snapshot_payload(uuid) TO service_role;

-- 1b) Fechamento legado passa a usar o payload corrigido
CREATE OR REPLACE FUNCTION public._legacy_close_daily_cash(p_daily_cash_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  dc record; v_worker_admin uuid; v_version int; v_payload jsonb; t jsonb;
BEGIN
  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id FOR UPDATE;
  IF dc.id IS NULL THEN RAISE EXCEPTION 'caixa não encontrado para reconciliação'; END IF;
  IF dc.admin_id IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa e o trabalhador deste caixa. O fechamento foi cancelado.';
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

-- 1c) Correção idempotente dos snapshots legados já gravados (nova versão)
CREATE OR REPLACE FUNCTION public.fix_legacy_snapshots(p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE r record; v_version int; v_payload jsonb; v_fixed int := 0;
BEGIN
  FOR r IN
    SELECT dc.id, dc.cash_date, dc.worker_id, dc.admin_id
      FROM public.daily_cash dc
     WHERE dc.close_origin = 'legacy_auto_reconciliation'
       AND dc.admin_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.daily_cash_snapshots s
          WHERE s.daily_cash_id = dc.id
            AND s.payload ? 'scope'
            AND (s.payload->>'snapshot_kind') = 'legacy_incomplete'
       )
     ORDER BY dc.cash_date
     LIMIT GREATEST(COALESCE(p_limit, 500), 1)
  LOOP
    v_payload := public._legacy_snapshot_payload(r.id);
    SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
      FROM public.daily_cash_snapshots WHERE daily_cash_id = r.id;
    INSERT INTO public.daily_cash_snapshots (
      daily_cash_id, cash_date, worker_id, admin_id,
      closed_at, closed_by, version, reopen_reason, payload
    ) VALUES (
      r.id, r.cash_date, r.worker_id, r.admin_id,
      now(), NULL, v_version, NULL, v_payload
    );
    v_fixed := v_fixed + 1;
  END LOOP;
  RETURN jsonb_build_object('fixed', v_fixed);
END $fn$;

REVOKE ALL ON FUNCTION public.fix_legacy_snapshots(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fix_legacy_snapshots(integer) TO service_role;

-- 2) Snapshot completo: reversed_events NUNCA inclui a contrapartida
CREATE OR REPLACE FUNCTION public.build_daily_cash_snapshot_v2(p_daily_cash_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
  rev AS (
    SELECT b.* FROM base b
     WHERE b.reverses_event_id IS NOT NULL OR b.event_type LIKE 'estorno%'
  )
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
     AND de.reversed_at IS NOT NULL
     AND de.reverses_event_id IS NULL
     AND de.event_type NOT LIKE 'estorno%';

  v_payload := v_payload
    || jsonb_build_object(
         'historical_complete', true,
         'snapshot_kind', 'complete',
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
GRANT EXECUTE ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) TO authenticated, service_role;

-- 3) Retentativas reais + datas faltantes em lote
CREATE OR REPLACE FUNCTION public.auto_close_cash_maintenance()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_yesterday date := ((now() AT TIME ZONE 'America/Sao_Paulo')::date) - 1;
  v_from date := public.auto_close_enabled_from();
  r record; res jsonb; v_cash uuid;
  v_closed int := 0; v_created int := 0; v_legacy int := 0; v_failed int := 0; v_retried int := 0;
BEGIN
  UPDATE public.auto_close_settings SET last_run_at = now(), updated_at = now();

  -- 3.1 caixas anteriores a ontem que continuam abertos: modo legado
  FOR r IN
    SELECT dc.id, dc.cash_date, dc.worker_id, dc.admin_id
      FROM public.daily_cash dc
     WHERE dc.status = 'open' AND dc.cash_date < v_yesterday AND dc.admin_id IS NOT NULL
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

  -- 3.2 ontem: fechamento completo (aberto ou nunca aberto)
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

  -- 3.3 datas obrigatórias faltantes (sem registro em daily_cash)
  IF v_from IS NOT NULL THEN
    FOR r IN
      SELECT w.id AS worker_id, w.parent_admin_id AS admin_id, d::date AS cash_date
        FROM public.workers w
        JOIN public.admins a ON a.id = w.parent_admin_id AND a.active = true
        CROSS JOIN LATERAL generate_series(
          GREATEST(v_from, (w.created_at AT TIME ZONE 'America/Sao_Paulo')::date),
          v_yesterday, interval '1 day') d
       WHERE w.active = true AND w.archived_at IS NULL AND w.parent_admin_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.company_access_controls cac
            WHERE cac.admin_id = w.parent_admin_id AND cac.manual_status = 'paused')
         AND NOT EXISTS (
           SELECT 1 FROM public.daily_cash dc
            WHERE dc.cash_date = d::date AND dc.worker_id = w.id AND dc.admin_id = w.parent_admin_id)
       ORDER BY d
       LIMIT 200
    LOOP
      BEGIN
        IF r.cash_date = v_yesterday THEN
          res := public._ensure_previous_daily_cash_closed(r.cash_date, r.worker_id, r.admin_id);
          v_created := v_created + 1;
        ELSE
          INSERT INTO public.daily_cash (cash_date, worker_id, admin_id, status, opening_balance)
          VALUES (r.cash_date, r.worker_id, r.admin_id, 'open', 0)
          RETURNING id INTO v_cash;
          PERFORM public._legacy_close_daily_cash(v_cash);
          v_legacy := v_legacy + 1;
        END IF;
        PERFORM public._resolve_auto_close_failure(r.cash_date, r.worker_id, r.admin_id);
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed + 1;
        PERFORM public._record_auto_close_failure(r.cash_date, r.worker_id, r.admin_id, NULL, SQLERRM);
      END;
    END LOOP;
  END IF;

  -- 3.4 retentativas reais das falhas registradas
  FOR r IN
    SELECT f.cash_date, f.worker_id, f.admin_id
      FROM public.auto_close_failures f
     WHERE f.resolved_at IS NULL
       AND f.next_retry_at <= now()
       AND f.cash_date < v_today
       AND f.admin_id IS NOT NULL
     ORDER BY f.cash_date
     LIMIT 200
  LOOP
    v_retried := v_retried + 1;
    IF public._resolve_auto_close_failure(r.cash_date, r.worker_id, r.admin_id) THEN
      CONTINUE;
    END IF;
    BEGIN
      v_cash := NULL;
      SELECT dc.id INTO v_cash FROM public.daily_cash dc
       WHERE dc.cash_date = r.cash_date AND dc.admin_id = r.admin_id
         AND dc.worker_id IS NOT DISTINCT FROM r.worker_id AND dc.status = 'open'
       LIMIT 1;

      IF v_cash IS NOT NULL THEN
        IF r.cash_date = v_yesterday THEN
          PERFORM public._ensure_previous_daily_cash_closed(r.cash_date, r.worker_id, r.admin_id);
        ELSE
          PERFORM public._legacy_close_daily_cash(v_cash);
        END IF;
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.daily_cash dc
         WHERE dc.cash_date = r.cash_date AND dc.admin_id = r.admin_id
           AND dc.worker_id IS NOT DISTINCT FROM r.worker_id
      ) AND (v_from IS NULL OR r.cash_date >= v_from) THEN
        IF r.cash_date = v_yesterday THEN
          PERFORM public._ensure_previous_daily_cash_closed(r.cash_date, r.worker_id, r.admin_id);
        ELSE
          INSERT INTO public.daily_cash (cash_date, worker_id, admin_id, status, opening_balance)
          VALUES (r.cash_date, r.worker_id, r.admin_id, 'open', 0)
          RETURNING id INTO v_cash;
          PERFORM public._legacy_close_daily_cash(v_cash);
        END IF;
      END IF;

      IF NOT public._resolve_auto_close_failure(r.cash_date, r.worker_id, r.admin_id) THEN
        PERFORM public._record_auto_close_failure(r.cash_date, r.worker_id, r.admin_id, NULL,
          'Fechamento ou snapshot ainda não concluídos');
        v_failed := v_failed + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public._record_auto_close_failure(r.cash_date, r.worker_id, r.admin_id, NULL, SQLERRM);
    END;
  END LOOP;

  UPDATE public.auto_close_settings
     SET last_success_at = CASE WHEN v_failed = 0 THEN now() ELSE last_success_at END,
         last_closed_count = v_closed + v_created + v_legacy,
         last_failed_count = v_failed,
         updated_at = now();

  RETURN jsonb_build_object(
    'cash_date', v_yesterday,
    'closed', v_closed, 'created_closed', v_created,
    'legacy_reconciled', v_legacy, 'retried', v_retried, 'failed', v_failed
  );
END $fn$;

REVOKE ALL ON FUNCTION public.auto_close_cash_maintenance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_close_cash_maintenance() TO service_role;

-- 4) Abertura: isolamento completo (cash_date + worker_id + admin_id)
CREATE OR REPLACE FUNCTION public.open_daily_cash(p_cash_date date, p_worker_id uuid DEFAULT NULL::uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_worker uuid; v_admin uuid; v_caller_admin uuid;
  v_is_admin boolean; v_is_super boolean;
  v_id uuid; v_status text; v_opening numeric := 0;
  v_target_worker_admin uuid; v_today date; v_pending date; v_reason text;
  v_missing date; v_failed_date date; r record;
BEGIN
  v_today := (now() AT TIME ZONE 'America/Sao_Paulo')::date;

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

  -- Pendências anteriores: caixa aberto, falha não resolvida ou dia faltante
  v_pending := public._scope_oldest_open_cash_date(v_worker, v_admin, v_today);

  SELECT MIN(f.cash_date) INTO v_failed_date FROM public.auto_close_failures f
   WHERE f.resolved_at IS NULL AND f.cash_date < v_today
     AND f.admin_id = v_admin AND f.worker_id IS NOT DISTINCT FROM v_worker;

  IF v_worker IS NOT NULL THEN
    SELECT MIN(d::date) INTO v_missing
      FROM public.workers w
      CROSS JOIN LATERAL generate_series(
        GREATEST(COALESCE(public.auto_close_enabled_from(), v_today),
                 (w.created_at AT TIME ZONE 'America/Sao_Paulo')::date),
        v_today - 1, interval '1 day') d
     WHERE w.id = v_worker AND w.parent_admin_id = v_admin
       AND NOT EXISTS (
         SELECT 1 FROM public.daily_cash dc
          WHERE dc.cash_date = d::date AND dc.worker_id = w.id AND dc.admin_id = v_admin);
  END IF;

  IF v_pending IS NOT NULL OR v_missing IS NOT NULL OR v_failed_date IS NOT NULL THEN
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

    v_pending := public._scope_oldest_open_cash_date(v_worker, v_admin, v_today);
    IF v_pending IS NOT NULL THEN
      RAISE EXCEPTION 'O caixa de % ainda está aberto e não pôde ser finalizado automaticamente. O caixa de hoje não foi aberto. Motivo: %',
        to_char(v_pending, 'DD/MM/YYYY'),
        COALESCE(v_reason, 'finalize ou solicite a reabertura desse dia');
    END IF;
  END IF;

  -- Caixa do dia (escopo completo: data + trabalhador + empresa)
  SELECT id, status INTO v_id, v_status FROM public.daily_cash
    WHERE cash_date = p_cash_date
      AND worker_id IS NOT DISTINCT FROM v_worker
      AND admin_id = v_admin
    LIMIT 1;

  IF v_id IS NOT NULL THEN
    IF v_status = 'cancelled' THEN
      UPDATE public.daily_cash
         SET status = 'open', cancelled_at = NULL, cancelled_by = NULL,
             cancellation_reason = NULL, opened_at = now(), opened_by = auth.uid()
       WHERE id = v_id;
      PERFORM public.log_audit('reabrir_caixa','cash',v_id,
        jsonb_build_object('status', v_status),
        jsonb_build_object('status','open','cash_date',p_cash_date,'action','reopen_after_cancel'),
        'Reabertura após cancelamento vazio', v_worker);
    END IF;
    RETURN v_id;
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

-- 5) Corrigir os snapshots legados já existentes
SELECT public.fix_legacy_snapshots(500);