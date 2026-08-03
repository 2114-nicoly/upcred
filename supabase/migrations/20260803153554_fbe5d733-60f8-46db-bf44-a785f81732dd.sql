-- 1) Configuração de ativação da automação
CREATE TABLE IF NOT EXISTS public.auto_close_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  enabled_from_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS auto_close_settings_singleton_idx
  ON public.auto_close_settings ((singleton));

GRANT SELECT ON public.auto_close_settings TO authenticated;
GRANT ALL ON public.auto_close_settings TO service_role;
ALTER TABLE public.auto_close_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auto_close_settings_select ON public.auto_close_settings;
CREATE POLICY auto_close_settings_select ON public.auto_close_settings
  FOR SELECT TO authenticated USING (true);

INSERT INTO public.auto_close_settings (singleton, enabled_from_date)
SELECT true, (now() AT TIME ZONE 'America/Sao_Paulo')::date
WHERE NOT EXISTS (SELECT 1 FROM public.auto_close_settings);

CREATE OR REPLACE FUNCTION public.auto_close_enabled_from()
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT enabled_from_date FROM public.auto_close_settings ORDER BY created_at LIMIT 1 $fn$;

-- 2) auto_close_failures: leitura restrita + deduplicação
ALTER TABLE public.auto_close_failures ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1;
ALTER TABLE public.auto_close_failures ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NOT NULL DEFAULT now();

WITH ranked AS (
  SELECT id, cash_date, admin_id, worker_id,
         row_number() OVER (PARTITION BY cash_date, admin_id, worker_id ORDER BY created_at DESC) AS rn,
         count(*) OVER (PARTITION BY cash_date, admin_id, worker_id) AS total
    FROM public.auto_close_failures
), keep AS (
  UPDATE public.auto_close_failures f
     SET attempt_count = r.total
    FROM ranked r
   WHERE f.id = r.id AND r.rn = 1
)
DELETE FROM public.auto_close_failures f
 USING ranked r
 WHERE f.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS auto_close_failures_scope_worker_uidx
  ON public.auto_close_failures (cash_date, admin_id, worker_id) WHERE worker_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auto_close_failures_scope_admin_uidx
  ON public.auto_close_failures (cash_date, admin_id) WHERE worker_id IS NULL;

DROP POLICY IF EXISTS auto_close_failures_select ON public.auto_close_failures;
CREATE POLICY auto_close_failures_select ON public.auto_close_failures
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR (
      public.has_role(auth.uid(), 'admin'::app_role)
      AND public.get_worker_id(auth.uid()) IS NULL
      AND admin_id = public.get_admin_id(auth.uid())
    )
  );

CREATE OR REPLACE FUNCTION public._record_auto_close_failure(
  p_date date, p_worker uuid, p_admin uuid, p_cash_id uuid, p_message text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_rows int;
BEGIN
  UPDATE public.auto_close_failures
     SET attempt_count = attempt_count + 1,
         last_attempt_at = now(),
         error_message = p_message,
         daily_cash_id = COALESCE(p_cash_id, daily_cash_id)
   WHERE cash_date = p_date
     AND admin_id IS NOT DISTINCT FROM p_admin
     AND worker_id IS NOT DISTINCT FROM p_worker;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    INSERT INTO public.auto_close_failures (cash_date, worker_id, admin_id, daily_cash_id, error_message)
    VALUES (p_date, p_worker, p_admin, p_cash_id, p_message);
  END IF;
END $fn$;

REVOKE ALL ON FUNCTION public._record_auto_close_failure(date, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._record_auto_close_failure(date, uuid, uuid, uuid, text) TO service_role;

-- 3) Fechamento núcleo: validações do manual, automático sem diferença
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

  IF v_auto THEN
    v_counted := v_expected;
    v_diff := 0;
  ELSE
    v_counted := COALESCE(p_counted, v_expected);
    IF v_counted < 0 THEN
      RAISE EXCEPTION 'O valor contado não pode ser negativo.';
    END IF;
    v_diff := v_counted - v_expected;
    IF abs(v_diff) > 0.01 AND (p_note IS NULL OR length(trim(p_note)) < 3) THEN
      RAISE EXCEPTION 'Há diferença entre o valor contado e o esperado. Escreva uma observação com pelo menos 3 caracteres.';
    END IF;
  END IF;

  v_final := v_opening + v_expected;

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

-- 4) Rotina interna única: garante o caixa do dia anterior fechado com snapshot
CREATE OR REPLACE FUNCTION public._ensure_previous_daily_cash_closed(
  p_date date, p_worker_id uuid, p_admin_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_from date := public.auto_close_enabled_from();
  v_id uuid; v_status text;
  v_opening numeric;
  v_worker_admin uuid;
  v_active boolean;
  v_origin text;
  v_has_snapshot boolean;
BEGIN
  IF p_admin_id IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa e o trabalhador deste caixa. O fechamento foi cancelado.';
  END IF;
  IF p_date IS DISTINCT FROM (v_today - 1) THEN
    RAISE EXCEPTION 'Somente o dia imediatamente anterior pode ser finalizado automaticamente.';
  END IF;
  IF v_from IS NULL OR p_date < v_from THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'before_enabled_from');
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

  IF p_worker_id IS NOT NULL THEN
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
     WHERE cash_date = p_date AND worker_id = p_worker_id AND admin_id = p_admin_id LIMIT 1;
  ELSE
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
     WHERE cash_date = p_date AND worker_id IS NULL AND admin_id = p_admin_id LIMIT 1;
  END IF;

  IF v_id IS NOT NULL AND v_status = 'closed' THEN
    RETURN jsonb_build_object('already_closed', true, 'cash_id', v_id);
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

  SELECT EXISTS (SELECT 1 FROM public.daily_cash_snapshots s WHERE s.daily_cash_id = v_id)
    INTO v_has_snapshot;
  IF NOT v_has_snapshot THEN
    RAISE EXCEPTION 'O fechamento não gerou o registro histórico obrigatório. O caixa continua aberto.';
  END IF;

  RETURN jsonb_build_object('cash_id', v_id, 'close_origin', v_origin);
END $fn$;

REVOKE ALL ON FUNCTION public._ensure_previous_daily_cash_closed(date, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._ensure_previous_daily_cash_closed(date, uuid, uuid) TO service_role;

-- 5) Cron reutiliza a rotina única, somente ontem
CREATE OR REPLACE FUNCTION public.auto_close_previous_day()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_day date;
  v_from date := public.auto_close_enabled_from();
  r record; res jsonb;
  v_closed int := 0; v_created int := 0; v_failed int := 0;
BEGIN
  v_day := ((now() AT TIME ZONE 'America/Sao_Paulo')::date) - 1;
  IF v_from IS NULL OR v_day < v_from THEN
    RETURN jsonb_build_object('cash_date', v_day, 'skipped', true, 'reason', 'before_enabled_from');
  END IF;

  FOR r IN
    SELECT dc.worker_id, dc.admin_id
      FROM public.daily_cash dc
     WHERE dc.cash_date = v_day AND dc.status = 'open' AND dc.admin_id IS NOT NULL
    UNION
    SELECT w.id, w.parent_admin_id
      FROM public.workers w
      JOIN public.admins a ON a.id = w.parent_admin_id AND a.active = true
     WHERE w.active = true AND w.archived_at IS NULL AND w.parent_admin_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.company_access_controls cac
          WHERE cac.admin_id = w.parent_admin_id AND cac.manual_status = 'paused')
       AND NOT EXISTS (
         SELECT 1 FROM public.daily_cash dc WHERE dc.cash_date = v_day AND dc.worker_id = w.id)
  LOOP
    BEGIN
      res := public._ensure_previous_daily_cash_closed(v_day, r.worker_id, r.admin_id);
      IF res ? 'close_origin' THEN
        IF res->>'close_origin' = 'automatic_not_opened' THEN v_created := v_created + 1;
        ELSE v_closed := v_closed + 1; END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      PERFORM public._record_auto_close_failure(v_day, r.worker_id, r.admin_id, NULL, SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('cash_date', v_day, 'closed', v_closed, 'created_closed', v_created, 'failed', v_failed);
END $fn$;

REVOKE ALL ON FUNCTION public.auto_close_previous_day() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_close_previous_day() TO service_role;

-- 6) Abertura de hoje exige o dia anterior finalizado com snapshot
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

  -- Garante que o caixa do dia anterior deste mesmo escopo já está fechado com snapshot
  IF v_admin IS NOT NULL THEN
    BEGIN
      PERFORM public._ensure_previous_daily_cash_closed(v_today - 1, v_worker, v_admin);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Não foi possível finalizar o caixa anterior. O caixa de hoje não foi aberto.';
    END;
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