-- 1) Origem do fechamento
ALTER TABLE public.daily_cash ADD COLUMN IF NOT EXISTS close_origin text;
ALTER TABLE public.daily_cash DROP CONSTRAINT IF EXISTS daily_cash_close_origin_check;
ALTER TABLE public.daily_cash ADD CONSTRAINT daily_cash_close_origin_check
  CHECK (close_origin IS NULL OR close_origin IN ('manual','automatic_opened','automatic_not_opened'));

-- 2) Registro de falhas do fechamento automático
CREATE TABLE IF NOT EXISTS public.auto_close_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_date date NOT NULL,
  worker_id uuid REFERENCES public.workers(id),
  admin_id uuid,
  daily_cash_id uuid,
  error_message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.auto_close_failures TO authenticated;
GRANT ALL ON public.auto_close_failures TO service_role;
ALTER TABLE public.auto_close_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auto_close_failures_select ON public.auto_close_failures;
CREATE POLICY auto_close_failures_select ON public.auto_close_failures
  FOR SELECT TO authenticated
  USING (public.is_super_admin(auth.uid()) OR admin_id = public.get_admin_id(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_auto_close_failures_date ON public.auto_close_failures (cash_date DESC);

-- 3) Rotina ÚNICA de fechamento (por daily_cash_id)
CREATE OR REPLACE FUNCTION public._close_daily_cash_core(
  p_daily_cash_id uuid,
  p_counted numeric,
  p_note text,
  p_origin text,
  p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  dc record;
  v_date date; v_worker uuid; v_admin uuid;
  v_opening numeric := 0;
  v_received numeric := 0; v_penalty numeric := 0; v_lent numeric := 0;
  v_manual_in numeric := 0; v_manual_out numeric := 0; v_expenses numeric := 0;
  v_in numeric := 0; v_out numeric := 0;
  v_not_paid int := 0; v_events int := 0;
  v_expected numeric := 0; v_counted numeric := 0; v_final numeric := 0; v_diff numeric := 0;
  v_payload jsonb; v_version int; v_reopen_reason text := NULL;
BEGIN
  IF p_origin NOT IN ('manual','automatic_opened','automatic_not_opened') THEN
    RAISE EXCEPTION 'origem de fechamento inválida';
  END IF;

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

  v_expected := (v_received + v_penalty + v_manual_in) - (v_lent + v_manual_out + v_expenses);
  v_counted := COALESCE(p_counted, v_expected);
  v_final := v_opening + v_expected;
  v_diff := v_counted - v_expected;

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
      'expected_worker_cash',v_expected,'counted',v_counted,'difference',v_diff,
      'final_available',v_final,'events',v_events,'close_origin',p_origin
    ),
    p_note, v_worker);

  RETURN jsonb_build_object('cash_id', p_daily_cash_id, 'version', v_version, 'close_origin', p_origin);
END $fn$;

REVOKE ALL ON FUNCTION public._close_daily_cash_core(uuid, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._close_daily_cash_core(uuid, numeric, text, text, uuid) TO service_role;

-- 4) Fechamento manual passa a usar a rotina única
CREATE OR REPLACE FUNCTION public.close_daily_cash_with_snapshot(p_cash_date date, p_counted numeric, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_worker uuid; v_admin uuid; v_id uuid;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

  IF v_worker IS NOT NULL THEN
    SELECT id INTO v_id FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id = v_worker LIMIT 1;
  ELSIF v_admin IS NOT NULL THEN
    SELECT id INTO v_id FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id = v_admin LIMIT 1;
  ELSE
    RAISE EXCEPTION 'usuário sem escopo (worker/admin) para fechar caixa';
  END IF;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'caixa deste dia ainda não foi aberto';
  END IF;

  RETURN public._close_daily_cash_core(v_id, p_counted, p_note, 'manual', auth.uid());
END $fn$;

REVOKE ALL ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text) TO authenticated, service_role;

-- 5) Fechamento automático — SOMENTE o dia anterior
CREATE OR REPLACE FUNCTION public.auto_close_previous_day()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_day date;
  r record;
  v_id uuid;
  v_opening numeric;
  v_closed int := 0; v_created int := 0; v_failed int := 0;
BEGIN
  v_day := ((now() AT TIME ZONE 'America/Sao_Paulo')::date) - 1;

  -- 5a) Caixas que permaneceram abertos exatamente nesse dia
  FOR r IN
    SELECT dc.id, dc.worker_id, dc.admin_id
      FROM public.daily_cash dc
     WHERE dc.cash_date = v_day AND dc.status = 'open' AND dc.admin_id IS NOT NULL
  LOOP
    BEGIN
      PERFORM public._close_daily_cash_core(r.id, NULL, NULL, 'automatic_opened', NULL);
      v_closed := v_closed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      INSERT INTO public.auto_close_failures (cash_date, worker_id, admin_id, daily_cash_id, error_message)
      VALUES (v_day, r.worker_id, r.admin_id, r.id, SQLERRM);
    END;
  END LOOP;

  -- 5b) Trabalhadores ativos que não abriram o caixa nesse dia
  FOR r IN
    SELECT w.id AS worker_id, w.parent_admin_id AS admin_id
      FROM public.workers w
      JOIN public.admins a ON a.id = w.parent_admin_id AND a.active = true
     WHERE w.active = true
       AND w.archived_at IS NULL
       AND w.parent_admin_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.company_access_controls cac
          WHERE cac.admin_id = w.parent_admin_id AND cac.manual_status = 'paused'
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.daily_cash dc
          WHERE dc.cash_date = v_day AND dc.worker_id = w.id
       )
  LOOP
    BEGIN
      SELECT GREATEST(COALESCE(cb.available_cash, 0), 0) INTO v_opening
        FROM public.cash_balance cb
       WHERE cb.worker_id = r.worker_id AND cb.admin_id = r.admin_id
       LIMIT 1;

      INSERT INTO public.daily_cash (
        cash_date, worker_id, admin_id, status, opening_balance, user_id
      ) VALUES (
        v_day, r.worker_id, r.admin_id, 'open', COALESCE(v_opening, 0), NULL
      ) RETURNING id INTO v_id;

      PERFORM public._close_daily_cash_core(
        v_id, NULL, 'Caixa não foi aberto e foi fechado automaticamente', 'automatic_not_opened', NULL);
      v_created := v_created + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      INSERT INTO public.auto_close_failures (cash_date, worker_id, admin_id, daily_cash_id, error_message)
      VALUES (v_day, r.worker_id, r.admin_id, NULL, SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('cash_date', v_day, 'closed', v_closed, 'created_closed', v_created, 'failed', v_failed);
END $fn$;

REVOKE ALL ON FUNCTION public.auto_close_previous_day() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_close_previous_day() TO service_role;

-- 6) Agendamento idempotente
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $do$
BEGIN
  PERFORM cron.unschedule('auto-close-daily-cash')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-close-daily-cash');
  PERFORM cron.schedule('auto-close-daily-cash', '*/5 * * * *', 'SELECT public.auto_close_previous_day();');
END $do$;