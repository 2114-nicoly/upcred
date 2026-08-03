-- ============================================================
-- v61: fechamento automático desligado + um único caixa aberto
-- ============================================================

-- 1) Remover TODOS os jobs de fechamento automático ------------------------
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job
     WHERE jobname IN ('auto-close-daily-cash')
        OR command ILIKE '%auto_close_previous_day%'
        OR command ILIKE '%auto_close_cash_maintenance%'
        OR command ILIKE '%reconcile_legacy_open_cash%';
  END IF;
END $do$;

-- 2) Funções de fechamento automático agora são inativas -------------------
CREATE OR REPLACE FUNCTION public.auto_close_previous_day()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT jsonb_build_object('disabled', true) $$;

CREATE OR REPLACE FUNCTION public.auto_close_cash_maintenance()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT jsonb_build_object('disabled', true) $$;

REVOKE ALL ON FUNCTION public.auto_close_previous_day() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_close_previous_day() TO service_role;
REVOKE ALL ON FUNCTION public.auto_close_cash_maintenance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_close_cash_maintenance() TO service_role;

-- 3) Caixa aberto do escopo (mais antigo) ----------------------------------
CREATE OR REPLACE FUNCTION public._scope_open_cash(p_worker uuid, p_admin uuid)
RETURNS TABLE (id uuid, cash_date date, status text, worker_id uuid, admin_id uuid, opening_balance numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT dc.id, dc.cash_date, dc.status, dc.worker_id, dc.admin_id,
         COALESCE(dc.opening_balance, 0)
    FROM public.daily_cash dc
   WHERE dc.status = 'open'
     AND dc.admin_id = p_admin
     AND dc.worker_id IS NOT DISTINCT FROM p_worker
   ORDER BY dc.cash_date ASC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public._scope_open_cash(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._scope_open_cash(uuid, uuid) TO authenticated, service_role;

-- 4) Proteção central: nunca dois caixas abertos no mesmo escopo -----------
CREATE OR REPLACE FUNCTION public.daily_cash_single_open_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_other date;
BEGIN
  IF NEW.status <> 'open' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'open' THEN RETURN NEW; END IF;
  IF NEW.admin_id IS NULL THEN RETURN NEW; END IF;

  SELECT dc.cash_date INTO v_other
    FROM public.daily_cash dc
   WHERE dc.status = 'open'
     AND dc.id <> NEW.id
     AND dc.admin_id = NEW.admin_id
     AND dc.worker_id IS NOT DISTINCT FROM NEW.worker_id
   ORDER BY dc.cash_date ASC
   LIMIT 1;

  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Existe um caixa aberto em %. Finalize esse caixa antes de abrir outro.',
      to_char(v_other, 'DD/MM/YYYY') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_cash_single_open_guard_trg ON public.daily_cash;
CREATE TRIGGER daily_cash_single_open_guard_trg
BEFORE INSERT OR UPDATE OF status ON public.daily_cash
FOR EACH ROW EXECUTE FUNCTION public.daily_cash_single_open_guard();

-- 5) RPC pública: caixa aberto do escopo autorizado ------------------------
CREATE OR REPLACE FUNCTION public.get_active_daily_cash(p_worker_id uuid DEFAULT NULL::uuid)
RETURNS TABLE (id uuid, cash_date date, status text, worker_id uuid, admin_id uuid, opening_balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid; v_admin uuid; v_caller_admin uuid;
  v_is_admin boolean; v_is_super boolean; v_target_admin uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'usuário não autenticado'; END IF;
  v_is_super := public.is_super_admin(auth.uid());
  v_is_admin := v_is_super OR public.has_role(auth.uid(), 'admin'::app_role);
  v_caller_admin := public.get_admin_id(auth.uid());

  IF p_worker_id IS NOT NULL THEN
    IF NOT v_is_admin THEN
      IF p_worker_id IS DISTINCT FROM public.get_worker_id(auth.uid()) THEN
        RAISE EXCEPTION 'caixa fora do seu escopo';
      END IF;
      v_worker := p_worker_id;
      SELECT parent_admin_id INTO v_admin FROM public.workers WHERE id = v_worker;
    ELSE
      SELECT parent_admin_id INTO v_target_admin FROM public.workers WHERE id = p_worker_id;
      IF v_target_admin IS NULL THEN RAISE EXCEPTION 'trabalhador não encontrado'; END IF;
      IF NOT v_is_super AND v_target_admin IS DISTINCT FROM v_caller_admin THEN
        RAISE EXCEPTION 'trabalhador não pertence à sua equipe';
      END IF;
      v_worker := p_worker_id;
      v_admin  := v_target_admin;
    END IF;
  ELSE
    v_worker := public.get_worker_id(auth.uid());
    v_admin  := v_caller_admin;
    IF v_worker IS NOT NULL THEN
      SELECT parent_admin_id INTO v_admin FROM public.workers WHERE id = v_worker;
    END IF;
  END IF;

  IF v_admin IS NULL THEN RAISE EXCEPTION 'usuário sem escopo (empresa)'; END IF;

  RETURN QUERY SELECT * FROM public._scope_open_cash(v_worker, v_admin);
END $$;
REVOKE ALL ON FUNCTION public.get_active_daily_cash(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_active_daily_cash(uuid) TO authenticated, service_role;

-- 6) Abertura de caixa: sem fechamento automático --------------------------
CREATE OR REPLACE FUNCTION public.open_daily_cash(p_cash_date date, p_worker_id uuid DEFAULT NULL::uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_worker uuid; v_admin uuid; v_caller_admin uuid;
  v_is_admin boolean; v_is_super boolean;
  v_id uuid; v_status text; v_opening numeric := 0;
  v_target_worker_admin uuid; v_today date; v_open record;
BEGIN
  v_today := (now() AT TIME ZONE 'America/Sao_Paulo')::date;

  IF p_cash_date IS NULL THEN RAISE EXCEPTION 'Data do caixa inválida.'; END IF;
  IF p_cash_date > v_today THEN
    RAISE EXCEPTION 'Não é permitido abrir caixa em data futura. Abra o caixa na própria data.';
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

  -- trava por empresa + trabalhador (evita corrida entre duas requisições)
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_admin::text || ':' || COALESCE(v_worker::text, '-'), 0)
  );

  -- já existe caixa aberto neste escopo?
  SELECT * INTO v_open FROM public._scope_open_cash(v_worker, v_admin);
  IF v_open.id IS NOT NULL THEN
    IF v_open.cash_date = p_cash_date THEN
      RETURN v_open.id;
    END IF;
    RAISE EXCEPTION 'Existe um caixa aberto em %. Finalize esse caixa antes de abrir outro.',
      to_char(v_open.cash_date, 'DD/MM/YYYY');
  END IF;

  IF p_cash_date < v_today THEN
    RAISE EXCEPTION 'Não é permitido abrir um caixa antigo. Utilize o processo de solicitação de reabertura.';
  END IF;

  SELECT id, status INTO v_id, v_status FROM public.daily_cash
    WHERE cash_date = p_cash_date
      AND worker_id IS NOT DISTINCT FROM v_worker
      AND admin_id = v_admin
    LIMIT 1;

  IF v_id IS NOT NULL THEN
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

-- 7) Reabertura: bloqueada quando existe outro caixa aberto ----------------
CREATE OR REPLACE FUNCTION public._reopen_daily_cash_core(
  p_daily_cash_id uuid,
  p_reason text,
  p_request_id uuid,
  p_actor_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  dc record; v_open record;
BEGIN
  IF p_daily_cash_id IS NULL THEN
    RAISE EXCEPTION 'caixa não informado';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'motivo da reabertura é obrigatório (mínimo 3 caracteres)';
  END IF;

  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'caixa não encontrado'; END IF;
  IF dc.admin_id IS NULL THEN RAISE EXCEPTION 'caixa sem empresa definida'; END IF;
  IF dc.worker_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workers w
     WHERE w.id = dc.worker_id AND w.parent_admin_id = dc.admin_id
  ) THEN
    RAISE EXCEPTION 'escopo inválido: trabalhador não pertence à empresa do caixa';
  END IF;
  IF dc.status <> 'closed' THEN RAISE EXCEPTION 'caixa não está fechado'; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(dc.admin_id::text || ':' || COALESCE(dc.worker_id::text, '-'), 0)
  );

  SELECT * INTO v_open FROM public._scope_open_cash(dc.worker_id, dc.admin_id);
  IF v_open.id IS NOT NULL THEN
    RAISE EXCEPTION 'Existe um caixa aberto em %. Finalize esse caixa antes de abrir outro.',
      to_char(v_open.cash_date, 'DD/MM/YYYY');
  END IF;

  UPDATE public.daily_cash
     SET status = 'open',
         closed_at = NULL,
         closed_by = NULL,
         counted_closing_balance = NULL,
         closing_difference = NULL,
         closing_note = NULL,
         close_origin = NULL,
         reopened_at = now(),
         reopened_by = p_actor_id,
         reopen_reason = trim(p_reason)
   WHERE id = p_daily_cash_id;

  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation,
    origin, user_id, worker_id, admin_id
  ) VALUES (
    dc.cash_date, 'caixa_aberto', 0, 0,
    'Caixa reaberto: ' || trim(p_reason),
    'caixa', p_actor_id, dc.worker_id, dc.admin_id
  );

  PERFORM public.log_audit(
    'reabrir_caixa', 'cash', p_daily_cash_id, NULL,
    jsonb_build_object(
      'cash_date', dc.cash_date,
      'worker_id', dc.worker_id,
      'admin_id', dc.admin_id,
      'reason', trim(p_reason),
      'request_id', p_request_id
    ),
    trim(p_reason), dc.worker_id
  );

  RETURN p_daily_cash_id;
END $$;
REVOKE ALL ON FUNCTION public._reopen_daily_cash_core(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._reopen_daily_cash_core(uuid, text, uuid, uuid) TO service_role;

-- 8) Fechamento manual: escopo completo, origem manual ---------------------
CREATE OR REPLACE FUNCTION public.close_daily_cash_with_snapshot(p_cash_date date, p_counted numeric, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_worker uuid; v_admin uuid; v_id uuid;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());
  IF v_worker IS NOT NULL THEN
    SELECT parent_admin_id INTO v_admin FROM public.workers WHERE id = v_worker;
  END IF;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'usuário sem escopo (empresa) para fechar caixa';
  END IF;

  SELECT id INTO v_id FROM public.daily_cash
    WHERE cash_date = p_cash_date
      AND worker_id IS NOT DISTINCT FROM v_worker
      AND admin_id = v_admin
    LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'caixa deste dia ainda não foi aberto';
  END IF;

  RETURN public._close_daily_cash_core(v_id, p_counted, p_note, 'manual', auth.uid());
END $fn$;
REVOKE ALL ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text) TO authenticated, service_role;

-- 9) Validação compartilhada: operar somente na data do caixa aberto -------
CREATE OR REPLACE FUNCTION public._assert_active_cash_date(p_cash_date date, p_worker uuid, p_admin uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_open record;
BEGIN
  IF public._cash_is_closed_for(p_cash_date, p_worker, p_admin) THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', p_cash_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF public._cash_is_open_for(p_cash_date, p_worker, p_admin) THEN
    RETURN;
  END IF;

  SELECT * INTO v_open FROM public._scope_open_cash(p_worker, p_admin);
  IF v_open.id IS NOT NULL THEN
    RAISE EXCEPTION 'O caixa aberto é o de %. Registre a operação nessa data ou finalize o caixa.',
      to_char(v_open.cash_date, 'DD/MM/YYYY') USING ERRCODE = 'check_violation';
  END IF;

  RAISE EXCEPTION 'Caixa do dia (%) ainda não foi aberto. Abra o caixa antes de registrar esta operação.', p_cash_date
    USING ERRCODE = 'check_violation';
END $$;
REVOKE ALL ON FUNCTION public._assert_active_cash_date(date, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._assert_active_cash_date(date, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_daily_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date; v_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker := OLD.worker_id; v_admin := OLD.admin_id; v_date := OLD.cash_date; v_type := OLD.event_type;
  ELSE
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.cash_date, CURRENT_DATE);
    v_type   := NEW.event_type;
  END IF;
  IF v_type IN ('pagamento','recebimento_multa','emprestimo_novo','renovacao','renegociacao','entrada_manual','saida_manual','quitacao','ajuste_manual','nao_pagou','estorno_pagamento','estorno_manual','despesa') THEN
    IF TG_OP = 'DELETE' THEN
      IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
        RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      PERFORM public._assert_active_cash_date(v_date, v_worker, v_admin);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_cash_movements()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker := OLD.worker_id; v_admin := OLD.admin_id; v_date := OLD.cash_date;
    IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
  v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
  v_date   := COALESCE(NEW.cash_date, CURRENT_DATE);
  IF TG_OP = 'INSERT' THEN
    PERFORM public._assert_active_cash_date(v_date, v_worker, v_admin);
  ELSIF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_not_paid_marks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker := OLD.worker_id; v_admin := OLD.admin_id; v_date := OLD.mark_date;
    IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
  v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
  v_date   := COALESCE(NEW.mark_date, CURRENT_DATE);
  IF TG_OP = 'INSERT' THEN
    PERFORM public._assert_active_cash_date(v_date, v_worker, v_admin);
  ELSIF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_loans()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.loan_date, CURRENT_DATE);
    PERFORM public._assert_active_cash_date(v_date, v_worker, v_admin);
  END IF;
  RETURN NEW;
END $$;