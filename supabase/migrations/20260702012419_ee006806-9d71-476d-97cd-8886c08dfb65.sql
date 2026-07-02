-- 1) Tabela de solicitações de reabertura de caixa
CREATE TABLE IF NOT EXISTS public.cash_reopen_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_date date NOT NULL,
  worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL,
  worker_name text,
  admin_id uuid,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_reopen_requests_status_check CHECK (status IN ('pending','approved','rejected','cancelled'))
);

GRANT SELECT, INSERT, UPDATE ON public.cash_reopen_requests TO authenticated;
GRANT ALL ON public.cash_reopen_requests TO service_role;

ALTER TABLE public.cash_reopen_requests ENABLE ROW LEVEL SECURITY;

-- Trabalhador vê e cria suas próprias; admin vê tudo do seu escopo; super_admin vê tudo.
DROP POLICY IF EXISTS "cash_reopen_requests_select" ON public.cash_reopen_requests;
CREATE POLICY "cash_reopen_requests_select"
  ON public.cash_reopen_requests FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role)
        AND admin_id = public.get_admin_id(auth.uid()))
    OR worker_id = public.get_worker_id(auth.uid())
    OR requested_by = auth.uid()
  );

DROP POLICY IF EXISTS "cash_reopen_requests_insert" ON public.cash_reopen_requests;
CREATE POLICY "cash_reopen_requests_insert"
  ON public.cash_reopen_requests FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Trabalhador só pode criar solicitação para si mesmo.
    worker_id = public.get_worker_id(auth.uid())
    OR public.is_super_admin(auth.uid())
    OR public.has_role(auth.uid(),'admin'::app_role)
  );

DROP POLICY IF EXISTS "cash_reopen_requests_update" ON public.cash_reopen_requests;
CREATE POLICY "cash_reopen_requests_update"
  ON public.cash_reopen_requests FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role)
        AND admin_id = public.get_admin_id(auth.uid()))
  )
  WITH CHECK (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role)
        AND admin_id = public.get_admin_id(auth.uid()))
  );

CREATE INDEX IF NOT EXISTS cash_reopen_requests_status_idx
  ON public.cash_reopen_requests (status, cash_date DESC);
CREATE INDEX IF NOT EXISTS cash_reopen_requests_scope_idx
  ON public.cash_reopen_requests (admin_id, worker_id, status);

CREATE OR REPLACE FUNCTION public.set_cash_reopen_requests_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_cash_reopen_requests_updated_at ON public.cash_reopen_requests;
CREATE TRIGGER trg_cash_reopen_requests_updated_at
BEFORE UPDATE ON public.cash_reopen_requests
FOR EACH ROW EXECUTE FUNCTION public.set_cash_reopen_requests_updated_at();

-- 2) RPC: aprovar solicitação (reabre o caixa oficialmente)
CREATE OR REPLACE FUNCTION public.approve_cash_reopen_request(
  p_request_id uuid,
  p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_req record;
  v_is_admin boolean;
  v_is_super boolean;
  v_caller_admin uuid;
BEGIN
  v_is_super := public.is_super_admin(auth.uid());
  v_is_admin := v_is_super OR public.has_role(auth.uid(),'admin'::app_role);
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'apenas administradores podem aprovar reabertura';
  END IF;

  SELECT * INTO v_req FROM public.cash_reopen_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'solicitação não encontrada'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'solicitação já foi respondida'; END IF;

  v_caller_admin := public.get_admin_id(auth.uid());
  IF NOT v_is_super AND v_req.admin_id IS DISTINCT FROM v_caller_admin THEN
    RAISE EXCEPTION 'solicitação fora do seu escopo';
  END IF;

  -- Reabre caixa reutilizando a lógica oficial. reopen_daily_cash usa o escopo do
  -- chamador; para reabrir o caixa do trabalhador solicitante, atualizamos direto
  -- o daily_cash e registramos evento/audit — evita depender do escopo do admin.
  UPDATE public.daily_cash
     SET status = 'open',
         closed_at = NULL,
         closed_by = NULL,
         closing_note = COALESCE(closing_note,'') ||
           CASE WHEN closing_note IS NULL OR closing_note = '' THEN '' ELSE E'\n' END ||
           '[Reaberto via solicitação #' || p_request_id::text || ']'
   WHERE cash_date = v_req.cash_date
     AND worker_id IS NOT DISTINCT FROM v_req.worker_id
     AND (v_req.worker_id IS NOT NULL OR admin_id IS NOT DISTINCT FROM v_req.admin_id)
     AND status = 'closed';

  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation,
    origin, user_id, worker_id, admin_id
  ) VALUES (
    v_req.cash_date, 'caixa_aberto', 0, 0,
    'Caixa reaberto após solicitação: ' || v_req.reason,
    'caixa', auth.uid(), v_req.worker_id, v_req.admin_id
  );

  UPDATE public.cash_reopen_requests
     SET status = 'approved',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = p_note
   WHERE id = p_request_id;

  PERFORM public.log_audit(
    'aprovar_reabertura_caixa','cash', p_request_id,
    jsonb_build_object('status','pending'),
    jsonb_build_object('status','approved','cash_date',v_req.cash_date,'reason',v_req.reason,'note',p_note),
    p_note, v_req.worker_id
  );

  RETURN p_request_id;
END; $$;

-- 3) RPC: recusar solicitação
CREATE OR REPLACE FUNCTION public.reject_cash_reopen_request(
  p_request_id uuid,
  p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_req record;
  v_is_admin boolean;
  v_is_super boolean;
  v_caller_admin uuid;
BEGIN
  v_is_super := public.is_super_admin(auth.uid());
  v_is_admin := v_is_super OR public.has_role(auth.uid(),'admin'::app_role);
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'apenas administradores podem recusar reabertura';
  END IF;

  SELECT * INTO v_req FROM public.cash_reopen_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'solicitação não encontrada'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'solicitação já foi respondida'; END IF;

  v_caller_admin := public.get_admin_id(auth.uid());
  IF NOT v_is_super AND v_req.admin_id IS DISTINCT FROM v_caller_admin THEN
    RAISE EXCEPTION 'solicitação fora do seu escopo';
  END IF;

  UPDATE public.cash_reopen_requests
     SET status = 'rejected',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = p_note
   WHERE id = p_request_id;

  PERFORM public.log_audit(
    'recusar_reabertura_caixa','cash', p_request_id,
    jsonb_build_object('status','pending'),
    jsonb_build_object('status','rejected','cash_date',v_req.cash_date,'reason',v_req.reason,'note',p_note),
    p_note, v_req.worker_id
  );

  RETURN p_request_id;
END; $$;