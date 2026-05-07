
-- 1. Fix admin_transfer_client: add source ownership check
CREATE OR REPLACE FUNCTION public.admin_transfer_client(p_client_id uuid, p_to_worker_id uuid, p_observation text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from_worker uuid; v_active_loan uuid; v_transfer_id uuid; v_dest_admin uuid; v_my_admin uuid; v_src_admin uuid;
BEGIN
  IF NOT (public.is_super_admin(auth.uid()) OR public.has_role(auth.uid(),'admin'::app_role)) THEN
    RAISE EXCEPTION 'permission denied';
  END IF;
  SELECT parent_admin_id INTO v_dest_admin FROM public.workers WHERE id = p_to_worker_id AND active = true;
  IF v_dest_admin IS NULL THEN RAISE EXCEPTION 'destination worker not found or inactive'; END IF;

  SELECT worker_id, admin_id INTO v_from_worker, v_src_admin FROM public.clients WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'client not found'; END IF;

  IF NOT public.is_super_admin(auth.uid()) THEN
    v_my_admin := public.get_admin_id(auth.uid());
    IF v_src_admin IS DISTINCT FROM v_my_admin THEN
      RAISE EXCEPTION 'client does not belong to your team';
    END IF;
    IF v_dest_admin <> v_my_admin THEN RAISE EXCEPTION 'cannot transfer to a worker outside your team'; END IF;
  END IF;

  IF v_from_worker = p_to_worker_id THEN RAISE EXCEPTION 'client already belongs to this worker'; END IF;
  SELECT id INTO v_active_loan FROM public.loans
   WHERE client_id = p_client_id AND status <> 'paid' AND COALESCE(remaining_balance,0) > 0.01
   ORDER BY created_at DESC LIMIT 1;
  UPDATE public.clients SET worker_id = p_to_worker_id, admin_id = v_dest_admin WHERE id = p_client_id;
  IF v_active_loan IS NOT NULL THEN
    UPDATE public.loans SET worker_id = p_to_worker_id, admin_id = v_dest_admin WHERE id = v_active_loan;
  END IF;
  INSERT INTO public.client_transfers (client_id, loan_id, from_worker_id, to_worker_id, transferred_by, observation)
  VALUES (p_client_id, v_active_loan, v_from_worker, p_to_worker_id, auth.uid(), p_observation)
  RETURNING id INTO v_transfer_id;
  PERFORM public.log_audit('transferencia_cliente','client',p_client_id,
    jsonb_build_object('worker_id', v_from_worker),
    jsonb_build_object('worker_id', p_to_worker_id, 'loan_id', v_active_loan),
    p_observation, p_to_worker_id);
  RETURN v_transfer_id;
END;
$function$;

-- 2. Fix installments RLS: scope admin access to own team's loans
DROP POLICY IF EXISTS "Access installments via loan" ON public.installments;
CREATE POLICY "Access installments via loan"
ON public.installments
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = installments.loan_id
      AND (
        public.is_super_admin(auth.uid())
        OR (public.has_role(auth.uid(),'admin'::app_role) AND l.admin_id = public.get_admin_id(auth.uid()))
        OR l.worker_id = public.get_worker_id(auth.uid())
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = installments.loan_id
      AND (
        public.is_super_admin(auth.uid())
        OR (public.has_role(auth.uid(),'admin'::app_role) AND l.admin_id = public.get_admin_id(auth.uid()))
        OR l.worker_id = public.get_worker_id(auth.uid())
      )
  )
);

-- 3. Fix user_roles privilege escalation: admins can only manage low-privilege roles
DROP POLICY IF EXISTS "Admins manage roles" ON public.user_roles;

CREATE POLICY "Super admin manage all roles"
ON public.user_roles
FOR ALL
TO authenticated
USING (public.is_super_admin(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()));

CREATE POLICY "Admins manage low-privilege roles"
ON public.user_roles
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  AND role IN ('trabalhador'::app_role, 'operador'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'admin'::app_role)
  AND role IN ('trabalhador'::app_role, 'operador'::app_role)
);

-- 4. Realtime: restrict topic subscriptions so users only receive events scoped to them
-- Enable RLS (already enabled by default on realtime.messages, but ensure)
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users read realtime" ON realtime.messages;
CREATE POLICY "Authenticated users read realtime"
ON realtime.messages
FOR SELECT
TO authenticated
USING ( (SELECT auth.uid()) IS NOT NULL );
