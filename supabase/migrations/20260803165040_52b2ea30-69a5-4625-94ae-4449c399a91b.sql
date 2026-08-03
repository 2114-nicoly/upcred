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

  SELECT * INTO dc FROM public.daily_cash WHERE id = p_daily_cash_id FOR UPDATE;
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

REVOKE ALL ON FUNCTION public.request_cash_reopen(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_cash_reopen(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.approve_cash_reopen_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_cash_reopen_request(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.reject_cash_reopen_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_cash_reopen_request(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_reopen_daily_cash(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reopen_daily_cash(uuid, text) TO authenticated;