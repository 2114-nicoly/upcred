-- 1) daily_cash_id em cash_reopen_requests
ALTER TABLE public.cash_reopen_requests
  ADD COLUMN IF NOT EXISTS daily_cash_id uuid REFERENCES public.daily_cash(id) ON DELETE SET NULL;

UPDATE public.cash_reopen_requests r
   SET daily_cash_id = dc.id
  FROM public.daily_cash dc
 WHERE r.daily_cash_id IS NULL
   AND dc.cash_date = r.cash_date
   AND dc.worker_id IS NOT DISTINCT FROM r.worker_id
   AND dc.admin_id IS NOT DISTINCT FROM r.admin_id;

-- índice único parcial: nunca duas pendentes para o mesmo caixa
CREATE UNIQUE INDEX IF NOT EXISTS cash_reopen_requests_pending_uidx
  ON public.cash_reopen_requests (daily_cash_id)
  WHERE status = 'pending' AND daily_cash_id IS NOT NULL;

-- 2) Função interna única de reabertura
CREATE OR REPLACE FUNCTION public._reopen_daily_cash_core(
  p_daily_cash_id uuid,
  p_reason text,
  p_request_id uuid,
  p_actor_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  dc record;
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

  -- um único evento de reabertura
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

-- 3) Solicitação do trabalhador
CREATE OR REPLACE FUNCTION public.request_cash_reopen(p_daily_cash_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  dc record;
  v_worker uuid;
  v_worker_name text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'usuário não autenticado'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'motivo é obrigatório (mínimo 3 caracteres)';
  END IF;

  v_worker := public.get_worker_id(auth.uid());
  IF v_worker IS NULL THEN RAISE EXCEPTION 'apenas trabalhadores solicitam reabertura'; END IF;

  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'caixa não encontrado'; END IF;
  IF dc.worker_id IS DISTINCT FROM v_worker THEN RAISE EXCEPTION 'caixa fora do seu escopo'; END IF;
  IF dc.admin_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.workers w WHERE w.id = v_worker AND w.parent_admin_id = dc.admin_id
  ) THEN
    RAISE EXCEPTION 'escopo inválido: trabalhador não pertence à empresa do caixa';
  END IF;
  IF dc.status <> 'closed' THEN RAISE EXCEPTION 'caixa não está fechado'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.cash_reopen_requests
     WHERE daily_cash_id = p_daily_cash_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'já existe uma solicitação pendente para este caixa';
  END IF;

  SELECT nome INTO v_worker_name FROM public.workers WHERE id = v_worker;

  INSERT INTO public.cash_reopen_requests (
    daily_cash_id, cash_date, worker_id, worker_name, admin_id,
    reason, status, requested_by, requested_at
  ) VALUES (
    p_daily_cash_id, dc.cash_date, v_worker, v_worker_name, dc.admin_id,
    trim(p_reason), 'pending', auth.uid(), now()
  ) RETURNING id INTO v_id;

  PERFORM public.log_audit(
    'solicitar_reabertura_caixa', 'cash', p_daily_cash_id, NULL,
    jsonb_build_object('cash_date', dc.cash_date, 'worker_id', v_worker,
                       'admin_id', dc.admin_id, 'reason', trim(p_reason), 'request_id', v_id),
    trim(p_reason), v_worker
  );

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.request_cash_reopen(uuid, text) TO authenticated;

-- 4) Aprovação e recusa
CREATE OR REPLACE FUNCTION public.approve_cash_reopen_request(p_request_id uuid, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_req record;
  v_is_super boolean;
  v_caller_admin uuid;
  v_cash_id uuid;
  v_count int;
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

  -- escopo do caixa deve bater com a solicitação (e com o admin, se não for super)
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

CREATE OR REPLACE FUNCTION public.reject_cash_reopen_request(p_request_id uuid, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_req record;
  v_is_super boolean;
  v_caller_admin uuid;
BEGIN
  v_is_super := public.is_super_admin(auth.uid());
  v_caller_admin := public.get_admin_id(auth.uid());
  IF NOT v_is_super AND NOT (public.has_role(auth.uid(),'admin'::app_role) AND v_caller_admin IS NOT NULL) THEN
    RAISE EXCEPTION 'apenas administradores podem recusar reabertura';
  END IF;

  SELECT * INTO v_req FROM public.cash_reopen_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'solicitação não encontrada'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'solicitação já foi respondida'; END IF;
  IF NOT v_is_super AND v_req.admin_id IS DISTINCT FROM v_caller_admin THEN
    RAISE EXCEPTION 'solicitação fora do seu escopo';
  END IF;

  UPDATE public.cash_reopen_requests
     SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
   WHERE id = p_request_id;

  PERFORM public.log_audit(
    'recusar_reabertura_caixa','cash', p_request_id,
    jsonb_build_object('status','pending'),
    jsonb_build_object('status','rejected','cash_date',v_req.cash_date,
                       'daily_cash_id',v_req.daily_cash_id,'reason',v_req.reason,'note',p_note),
    p_note, v_req.worker_id
  );

  RETURN p_request_id;
END $$;

GRANT EXECUTE ON FUNCTION public.approve_cash_reopen_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_cash_reopen_request(uuid, text) TO authenticated;

-- 5) Reabertura direta pelo administrador
CREATE OR REPLACE FUNCTION public.admin_reopen_daily_cash(p_daily_cash_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  dc record;
  v_is_super boolean;
  v_caller_admin uuid;
  v_worker_name text;
  v_req_id uuid;
BEGIN
  v_is_super := public.is_super_admin(auth.uid());
  v_caller_admin := public.get_admin_id(auth.uid());
  IF NOT v_is_super AND NOT (public.has_role(auth.uid(),'admin'::app_role) AND v_caller_admin IS NOT NULL) THEN
    RAISE EXCEPTION 'apenas administradores podem reabrir o caixa';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'motivo da reabertura é obrigatório (mínimo 3 caracteres)';
  END IF;

  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'caixa não encontrado'; END IF;
  IF NOT v_is_super AND dc.admin_id IS DISTINCT FROM v_caller_admin THEN
    RAISE EXCEPTION 'caixa fora do seu escopo';
  END IF;
  IF dc.status <> 'closed' THEN RAISE EXCEPTION 'caixa não está fechado'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.cash_reopen_requests
     WHERE daily_cash_id = p_daily_cash_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'existe uma solicitação pendente para este caixa: aprove ou recuse';
  END IF;

  IF dc.worker_id IS NOT NULL THEN
    SELECT nome INTO v_worker_name FROM public.workers WHERE id = dc.worker_id;
  END IF;

  INSERT INTO public.cash_reopen_requests (
    daily_cash_id, cash_date, worker_id, worker_name, admin_id,
    reason, status, requested_by, requested_at, reviewed_by, reviewed_at, review_note
  ) VALUES (
    p_daily_cash_id, dc.cash_date, dc.worker_id, v_worker_name, dc.admin_id,
    trim(p_reason), 'approved', auth.uid(), now(), auth.uid(), now(),
    'Reabertura direta pelo administrador'
  ) RETURNING id INTO v_req_id;

  PERFORM public._reopen_daily_cash_core(p_daily_cash_id, trim(p_reason), v_req_id, auth.uid());

  RETURN p_daily_cash_id;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_reopen_daily_cash(uuid, text) TO authenticated;

-- 6) Permissões: nada de escrita direta
REVOKE ALL ON FUNCTION public.reopen_daily_cash(date, text) FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.cash_reopen_requests FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.daily_cash FROM authenticated, anon;
GRANT SELECT ON public.cash_reopen_requests TO authenticated;
GRANT SELECT ON public.daily_cash TO authenticated;
GRANT ALL ON public.cash_reopen_requests TO service_role;
GRANT ALL ON public.daily_cash TO service_role;