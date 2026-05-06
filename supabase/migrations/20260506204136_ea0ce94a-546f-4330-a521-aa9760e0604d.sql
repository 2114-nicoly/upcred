
-- =====================================================
-- AUDIT LOGS
-- =====================================================
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  user_role text,
  worker_id uuid,
  action_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  old_value jsonb,
  new_value jsonb,
  observation text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX idx_audit_logs_worker ON public.audit_logs (worker_id);
CREATE INDEX idx_audit_logs_user ON public.audit_logs (user_id);
CREATE INDEX idx_audit_logs_action ON public.audit_logs (action_type);
CREATE INDEX idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin sees all audit logs"
  ON public.audit_logs FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Worker sees own audit logs"
  ON public.audit_logs FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND worker_id = public.get_worker_id(auth.uid())
  );

-- inserts only via SECURITY DEFINER function
CREATE POLICY "Authenticated insert audit logs"
  ON public.audit_logs FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- =====================================================
-- CLIENT TRANSFERS
-- =====================================================
CREATE TABLE public.client_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  loan_id uuid,
  from_worker_id uuid,
  to_worker_id uuid NOT NULL,
  transferred_by uuid NOT NULL,
  observation text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transfers_client ON public.client_transfers (client_id);
CREATE INDEX idx_transfers_to ON public.client_transfers (to_worker_id);
CREATE INDEX idx_transfers_from ON public.client_transfers (from_worker_id);

ALTER TABLE public.client_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage client_transfers"
  ON public.client_transfers FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Workers see own client_transfers"
  ON public.client_transfers FOR SELECT
  TO authenticated
  USING (
    from_worker_id = public.get_worker_id(auth.uid())
    OR to_worker_id = public.get_worker_id(auth.uid())
  );

-- =====================================================
-- FUNCTION: log_audit
-- =====================================================
CREATE OR REPLACE FUNCTION public.log_audit(
  p_action text,
  p_entity text,
  p_entity_id uuid DEFAULT NULL,
  p_old jsonb DEFAULT NULL,
  p_new jsonb DEFAULT NULL,
  p_obs text DEFAULT NULL,
  p_worker_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_role text;
  v_worker uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  IF public.has_role(auth.uid(), 'admin') THEN
    v_role := 'admin';
  ELSE
    v_role := 'trabalhador';
  END IF;

  v_worker := COALESCE(p_worker_id, public.get_worker_id(auth.uid()));

  INSERT INTO public.audit_logs (
    user_id, user_role, worker_id, action_type, entity_type,
    entity_id, old_value, new_value, observation
  ) VALUES (
    auth.uid(), v_role, v_worker, p_action, p_entity,
    p_entity_id, p_old, p_new, p_obs
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- =====================================================
-- FUNCTION: admin_transfer_client
-- Move client + active loan + pending installments
-- to a new worker. Old data stays with original worker.
-- =====================================================
CREATE OR REPLACE FUNCTION public.admin_transfer_client(
  p_client_id uuid,
  p_to_worker_id uuid,
  p_observation text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from_worker uuid;
  v_active_loan uuid;
  v_transfer_id uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  -- validate destination worker
  IF NOT EXISTS (SELECT 1 FROM public.workers WHERE id = p_to_worker_id AND active = true) THEN
    RAISE EXCEPTION 'destination worker not found or inactive';
  END IF;

  -- fetch current worker of client
  SELECT worker_id INTO v_from_worker
  FROM public.clients
  WHERE id = p_client_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'client not found';
  END IF;

  IF v_from_worker = p_to_worker_id THEN
    RAISE EXCEPTION 'client already belongs to this worker';
  END IF;

  -- find active loan (open or overdue)
  SELECT id INTO v_active_loan
  FROM public.loans
  WHERE client_id = p_client_id
    AND status <> 'paid'
    AND COALESCE(remaining_balance, 0) > 0.01
  ORDER BY created_at DESC
  LIMIT 1;

  -- update client owner
  UPDATE public.clients
  SET worker_id = p_to_worker_id
  WHERE id = p_client_id;

  -- update active loan owner (if any) and pending installments stay tied to loan
  IF v_active_loan IS NOT NULL THEN
    UPDATE public.loans
    SET worker_id = p_to_worker_id
    WHERE id = v_active_loan;
  END IF;

  -- record transfer
  INSERT INTO public.client_transfers (
    client_id, loan_id, from_worker_id, to_worker_id,
    transferred_by, observation
  ) VALUES (
    p_client_id, v_active_loan, v_from_worker, p_to_worker_id,
    auth.uid(), p_observation
  )
  RETURNING id INTO v_transfer_id;

  -- audit log
  PERFORM public.log_audit(
    'transferencia_cliente',
    'client',
    p_client_id,
    jsonb_build_object('worker_id', v_from_worker),
    jsonb_build_object('worker_id', p_to_worker_id, 'loan_id', v_active_loan),
    p_observation,
    p_to_worker_id
  );

  RETURN v_transfer_id;
END;
$$;

-- =====================================================
-- LIST WORKERS RPC (for admin filter dropdown)
-- =====================================================
CREATE OR REPLACE FUNCTION public.admin_list_workers()
RETURNS TABLE (id uuid, nome text, login_codigo text, active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, nome, login_codigo, active
  FROM public.workers
  WHERE public.has_role(auth.uid(), 'admin')
  ORDER BY active DESC, nome ASC;
$$;
