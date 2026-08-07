ALTER TABLE public.cash_reopen_requests
  ADD COLUMN IF NOT EXISTS request_type text NOT NULL DEFAULT 'reopen';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_reopen_requests_request_type_chk') THEN
    ALTER TABLE public.cash_reopen_requests
      ADD CONSTRAINT cash_reopen_requests_request_type_chk
      CHECK (request_type IN ('reopen','open_missed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS cash_reopen_requests_pending_missed_uidx
  ON public.cash_reopen_requests (cash_date, worker_id, admin_id)
  WHERE status = 'pending' AND request_type = 'open_missed';

-- Saldo inicial histórico para um dia antigo, estritamente no escopo worker+admin
CREATE OR REPLACE FUNCTION public._historic_opening_balance(p_worker uuid, p_admin uuid, p_cash_date date)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_val numeric;
BEGIN
  SELECT dc.expected_closing_balance INTO v_val
    FROM public.daily_cash dc
   WHERE dc.worker_id IS NOT DISTINCT FROM p_worker
     AND dc.admin_id = p_admin
     AND dc.cash_date < p_cash_date
   ORDER BY dc.cash_date DESC
   LIMIT 1;
  IF v_val IS NOT NULL THEN RETURN GREATEST(v_val, 0); END IF;

  SELECT dc.opening_balance INTO v_val
    FROM public.daily_cash dc
   WHERE dc.worker_id IS NOT DISTINCT FROM p_worker
     AND dc.admin_id = p_admin
     AND dc.cash_date > p_cash_date
   ORDER BY dc.cash_date ASC
   LIMIT 1;
  IF v_val IS NOT NULL THEN RETURN GREATEST(v_val, 0); END IF;

  SELECT cb.available_cash INTO v_val
    FROM public.cash_balance cb
   WHERE cb.worker_id IS NOT DISTINCT FROM p_worker
     AND cb.admin_id = p_admin
   LIMIT 1;
  RETURN GREATEST(COALESCE(v_val, 0), 0);
END $$;

REVOKE ALL ON FUNCTION public._historic_opening_balance(uuid, uuid, date) FROM PUBLIC, anon, authenticated;

-- Trabalhador solicita abertura de um dia antigo que nunca teve caixa
CREATE OR REPLACE FUNCTION public.request_missed_cash_open(p_cash_date date, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_worker uuid; v_admin uuid; v_worker_name text; v_today date; v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'usuário não autenticado'; END IF;
  IF p_cash_date IS NULL THEN RAISE EXCEPTION 'data inválida'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'motivo é obrigatório (mínimo 3 caracteres)';
  END IF;

  v_today := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  IF p_cash_date >= v_today THEN
    RAISE EXCEPTION 'somente datas anteriores a hoje podem ser solicitadas';
  END IF;

  v_worker := public.get_worker_id(auth.uid());
  IF v_worker IS NULL THEN RAISE EXCEPTION 'apenas trabalhadores solicitam abertura de dia antigo'; END IF;

  SELECT w.parent_admin_id, w.nome INTO v_admin, v_worker_name
    FROM public.workers w WHERE w.id = v_worker;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'trabalhador sem empresa vinculada'; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_admin::text || ':' || v_worker::text || ':' || p_cash_date::text, 0)
  );

  IF EXISTS (
    SELECT 1 FROM public.daily_cash dc
     WHERE dc.cash_date = p_cash_date
       AND dc.worker_id IS NOT DISTINCT FROM v_worker
       AND dc.admin_id = v_admin
  ) THEN
    RAISE EXCEPTION 'já existe caixa nesta data: utilize a solicitação de reabertura';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cash_reopen_requests r
     WHERE r.status = 'pending' AND r.request_type = 'open_missed'
       AND r.cash_date = p_cash_date
       AND r.worker_id IS NOT DISTINCT FROM v_worker
       AND r.admin_id = v_admin
  ) THEN
    RAISE EXCEPTION 'já existe uma solicitação pendente para esta data';
  END IF;

  INSERT INTO public.cash_reopen_requests (
    cash_date, worker_id, worker_name, admin_id, reason, status,
    requested_by, requested_at, request_type, daily_cash_id
  ) VALUES (
    p_cash_date, v_worker, v_worker_name, v_admin, trim(p_reason), 'pending',
    auth.uid(), now(), 'open_missed', NULL
  ) RETURNING id INTO v_id;

  PERFORM public.log_audit(
    'solicitar_abertura_caixa_antigo','cash', v_id, NULL,
    jsonb_build_object('cash_date', p_cash_date, 'reason', trim(p_reason),
                       'worker_id', v_worker, 'admin_id', v_admin,
                       'request_type', 'open_missed'),
    trim(p_reason), v_worker
  );

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.request_missed_cash_open(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_missed_cash_open(date, text) TO authenticated;

-- Aprovação: suporta reabertura normal e abertura de dia antigo
CREATE OR REPLACE FUNCTION public.approve_cash_reopen_request(p_request_id uuid, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_is_super boolean;
  v_caller_admin uuid;
  v_cash_id uuid;
  v_count int;
  v_open record;
  v_opening numeric;
BEGIN
  v_is_super := public.is_super_admin(auth.uid());
  v_caller_admin := public.get_admin_id(auth.uid());
  IF NOT v_is_super AND NOT (public.has_role(auth.uid(),'admin'::app_role) AND v_caller_admin IS NOT NULL) THEN
    RAISE EXCEPTION 'apenas administradores podem aprovar reabertura';
  END IF;

  SELECT * INTO v_req FROM public.cash_reopen_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'solicitação não encontrada'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'solicitação já foi respondida'; END IF;
  IF NOT v_is_super AND v_req.admin_id IS DISTINCT FROM v_caller_admin THEN
    RAISE EXCEPTION 'solicitação fora do seu escopo';
  END IF;

  IF v_req.request_type = 'open_missed' THEN
    IF v_req.admin_id IS NULL THEN RAISE EXCEPTION 'solicitação sem empresa'; END IF;
    IF v_req.worker_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.workers w
       WHERE w.id = v_req.worker_id AND w.parent_admin_id = v_req.admin_id
    ) THEN
      RAISE EXCEPTION 'trabalhador não pertence à empresa da solicitação';
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_req.admin_id::text || ':' || COALESCE(v_req.worker_id::text,'-'), 0)
    );

    IF EXISTS (
      SELECT 1 FROM public.daily_cash dc
       WHERE dc.cash_date = v_req.cash_date
         AND dc.worker_id IS NOT DISTINCT FROM v_req.worker_id
         AND dc.admin_id = v_req.admin_id
    ) THEN
      RAISE EXCEPTION 'já existe caixa nesta data: utilize a reabertura';
    END IF;

    SELECT * INTO v_open FROM public._scope_open_cash(v_req.worker_id, v_req.admin_id);
    IF v_open.id IS NOT NULL THEN
      RAISE EXCEPTION 'Existe um caixa aberto em %. Finalize esse caixa antes de aprovar.',
        to_char(v_open.cash_date, 'DD/MM/YYYY');
    END IF;

    v_opening := public._historic_opening_balance(v_req.worker_id, v_req.admin_id, v_req.cash_date);

    INSERT INTO public.daily_cash (
      cash_date, worker_id, admin_id, status, opening_balance,
      opened_at, opened_by, reopened_at, reopened_by, reopen_reason, user_id
    ) VALUES (
      v_req.cash_date, v_req.worker_id, v_req.admin_id, 'open', v_opening,
      now(), auth.uid(), now(), auth.uid(), v_req.reason, auth.uid()
    ) RETURNING id INTO v_cash_id;

    INSERT INTO public.daily_events (
      cash_date, event_type, amount_in, amount_out, observation,
      origin, user_id, worker_id, admin_id
    ) VALUES (
      v_req.cash_date, 'caixa_aberto', 0, 0, 'Caixa aberto por aprovação de solicitação',
      'caixa', auth.uid(), v_req.worker_id, v_req.admin_id
    );

    UPDATE public.cash_reopen_requests
       SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
           review_note = p_note, daily_cash_id = v_cash_id
     WHERE id = p_request_id;

    PERFORM public.log_audit(
      'aprovar_abertura_caixa_antigo','cash', p_request_id,
      jsonb_build_object('status','pending'),
      jsonb_build_object('status','approved','cash_date',v_req.cash_date,
                         'daily_cash_id',v_cash_id,'opening_balance',v_opening,
                         'worker_id',v_req.worker_id,'admin_id',v_req.admin_id,
                         'reason',v_req.reason,'note',p_note),
      p_note, v_req.worker_id
    );

    RETURN v_cash_id;
  END IF;

  v_cash_id := v_req.daily_cash_id;
  IF v_cash_id IS NULL THEN
    SELECT count(*) INTO v_count FROM public.daily_cash
     WHERE cash_date = v_req.cash_date
       AND worker_id IS NOT DISTINCT FROM v_req.worker_id
       AND admin_id IS NOT DISTINCT FROM v_req.admin_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'não foi possível identificar o caixa desta solicitação';
    END IF;
    SELECT id INTO v_cash_id FROM public.daily_cash
     WHERE cash_date = v_req.cash_date
       AND worker_id IS NOT DISTINCT FROM v_req.worker_id
       AND admin_id IS NOT DISTINCT FROM v_req.admin_id;
    UPDATE public.cash_reopen_requests SET daily_cash_id = v_cash_id WHERE id = p_request_id;
  END IF;

  PERFORM 1 FROM public.daily_cash dc
    WHERE dc.id = v_cash_id
      AND dc.worker_id IS NOT DISTINCT FROM v_req.worker_id
      AND dc.admin_id IS NOT DISTINCT FROM v_req.admin_id
      AND (v_is_super OR dc.admin_id = v_caller_admin);
  IF NOT FOUND THEN RAISE EXCEPTION 'caixa fora do escopo da solicitação'; END IF;

  PERFORM public._reopen_daily_cash_core(v_cash_id, v_req.reason, p_request_id, auth.uid());

  UPDATE public.cash_reopen_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
   WHERE id = p_request_id;

  PERFORM public.log_audit(
    'aprovar_reabertura_caixa','cash', p_request_id,
    jsonb_build_object('status','pending'),
    jsonb_build_object('status','approved','cash_date',v_req.cash_date,'daily_cash_id',v_cash_id,
                       'reason',v_req.reason,'note',p_note),
    p_note, v_req.worker_id
  );

  RETURN v_cash_id;
END $$;

REVOKE ALL ON FUNCTION public.approve_cash_reopen_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_cash_reopen_request(uuid, text) TO authenticated;