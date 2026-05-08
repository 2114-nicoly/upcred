
-- 1) Super Admin nunca aparece como admin comum
CREATE OR REPLACE FUNCTION public.super_admin_list_admins()
RETURNS TABLE(id uuid, nome text, email_real text, login_codigo text, active boolean, created_at timestamp with time zone)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT a.id, a.nome, a.email_real, a.login_codigo, a.active, a.created_at
  FROM public.admins a
  WHERE public.is_super_admin(auth.uid())
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = a.auth_user_id AND ur.role = 'super_admin'::app_role
    )
  ORDER BY a.active DESC, a.nome ASC;
$$;

-- 2) Trigger: cliente exige worker_id + admin_id ao inserir
CREATE OR REPLACE FUNCTION public.clients_require_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  -- super_admin pode bypass (precisa atribuir manualmente, mas se não atribuir não bloqueia para casos administrativos)
  IF public.is_super_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF NEW.worker_id IS NULL OR NEW.admin_id IS NULL THEN
    RAISE EXCEPTION 'cliente deve ter trabalhador e administrador responsáveis';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clients_require_scope ON public.clients;
CREATE TRIGGER trg_clients_require_scope
  BEFORE INSERT ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.clients_require_scope();

-- 3) Trigger: edição comum não pode alterar worker_id/admin_id (só via transferência)
CREATE OR REPLACE FUNCTION public.clients_lock_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_allow text;
BEGIN
  -- A função de transferência seta a GUC abaixo
  BEGIN
    v_allow := current_setting('app.allow_client_transfer', true);
  EXCEPTION WHEN OTHERS THEN v_allow := NULL;
  END;
  IF v_allow = 'true' THEN
    RETURN NEW;
  END IF;
  IF NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.admin_id IS DISTINCT FROM OLD.admin_id THEN
    RAISE EXCEPTION 'trabalhador/administrador do cliente só pode mudar via transferência oficial';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clients_lock_scope ON public.clients;
CREATE TRIGGER trg_clients_lock_scope
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.clients_lock_scope();

-- 4) admin_transfer_client deve liberar a GUC durante a operação
CREATE OR REPLACE FUNCTION public.admin_transfer_client(p_client_id uuid, p_to_worker_id uuid, p_observation text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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

  -- libera o lock para esta transação
  PERFORM set_config('app.allow_client_transfer', 'true', true);

  UPDATE public.clients SET worker_id = p_to_worker_id, admin_id = v_dest_admin WHERE id = p_client_id;
  IF v_active_loan IS NOT NULL THEN
    UPDATE public.loans SET worker_id = p_to_worker_id, admin_id = v_dest_admin WHERE id = v_active_loan;
  END IF;

  PERFORM set_config('app.allow_client_transfer', 'false', true);

  INSERT INTO public.client_transfers (client_id, loan_id, from_worker_id, to_worker_id, transferred_by, observation)
  VALUES (p_client_id, v_active_loan, v_from_worker, p_to_worker_id, auth.uid(), p_observation)
  RETURNING id INTO v_transfer_id;
  PERFORM public.log_audit('transferencia_cliente','client',p_client_id,
    jsonb_build_object('worker_id', v_from_worker),
    jsonb_build_object('worker_id', p_to_worker_id, 'loan_id', v_active_loan),
    p_observation, p_to_worker_id);
  RETURN v_transfer_id;
END;
$$;

-- 5) RPC para trabalhador criar cliente já vinculado a si + admin responsável
CREATE OR REPLACE FUNCTION public.worker_create_client(
  p_name text, p_phone text DEFAULT NULL,
  p_notes text DEFAULT NULL, p_full_name text DEFAULT NULL, p_address text DEFAULT NULL,
  p_doc_primary_type text DEFAULT NULL, p_doc_primary_number text DEFAULT NULL,
  p_doc_secondary_type text DEFAULT NULL, p_doc_secondary_number text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid; v_worker uuid; v_admin uuid; v_next_code int;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  IF v_worker IS NULL THEN
    RAISE EXCEPTION 'apenas trabalhador pode usar esta função';
  END IF;
  SELECT parent_admin_id INTO v_admin FROM public.workers WHERE id = v_worker;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'trabalhador sem administrador responsável; contate o admin';
  END IF;

  SELECT COALESCE(MAX(client_code),0)+1 INTO v_next_code FROM public.clients;

  INSERT INTO public.clients (
    name, phone, notes, client_code, worker_id, admin_id, user_id,
    full_name, address, doc_primary_type, doc_primary_number, doc_secondary_type, doc_secondary_number
  ) VALUES (
    trim(p_name), NULLIF(p_phone,''), NULLIF(p_notes,''), v_next_code, v_worker, v_admin, auth.uid(),
    NULLIF(trim(COALESCE(p_full_name,'')),''), NULLIF(trim(COALESCE(p_address,'')),''),
    NULLIF(p_doc_primary_type,''), NULLIF(p_doc_primary_number,''),
    NULLIF(p_doc_secondary_type,''), NULLIF(p_doc_secondary_number,'')
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- 6) Última credencial gerada para um trabalhador/admin
CREATE OR REPLACE FUNCTION public.get_latest_credential(p_kind text, p_target_id uuid)
RETURNS TABLE(login_codigo text, temp_password text, created_at timestamptz, created_by uuid, reason text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_allowed boolean := false; v_parent uuid;
BEGIN
  IF p_kind = 'worker' THEN
    SELECT parent_admin_id INTO v_parent FROM public.workers WHERE id = p_target_id;
    IF public.is_super_admin(auth.uid())
       OR (public.has_role(auth.uid(),'admin'::app_role) AND v_parent = public.get_admin_id(auth.uid())) THEN
      v_allowed := true;
    END IF;
    IF NOT v_allowed THEN RAISE EXCEPTION 'access denied'; END IF;
    RETURN QUERY
      SELECT l.login_codigo, l.temp_password, l.created_at, l.created_by, l.reason, l.status
      FROM public.worker_credentials_log l
      WHERE l.worker_id = p_target_id
      ORDER BY l.created_at DESC LIMIT 1;
  ELSIF p_kind = 'admin' THEN
    IF NOT public.is_super_admin(auth.uid()) THEN RAISE EXCEPTION 'access denied'; END IF;
    RETURN QUERY
      SELECT l.login_codigo, l.temp_password, l.created_at, l.created_by, l.reason, l.status
      FROM public.worker_credentials_log l
      WHERE l.admin_id = p_target_id AND l.role = 'admin'
      ORDER BY l.created_at DESC LIMIT 1;
  ELSE
    RAISE EXCEPTION 'kind inválido';
  END IF;
END $$;

-- 7) Lista alertas de recuperação de senha do escopo do usuário
CREATE OR REPLACE FUNCTION public.list_password_recovery_alerts()
RETURNS TABLE(id uuid, login_informado text, nome_informado text, email_informado text,
              target_role text, target_admin_id uuid, requested_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT r.id, r.login_informado, r.nome_informado, r.email_informado,
         r.target_role, r.target_admin_id, r.requested_at
  FROM public.password_recovery_requests r
  WHERE r.status = 'open'
    AND (
      public.is_super_admin(auth.uid())
      OR (public.has_role(auth.uid(),'admin'::app_role) AND r.target_admin_id = public.get_admin_id(auth.uid()))
    )
  ORDER BY r.requested_at DESC;
$$;

-- 8) Índices úteis
CREATE INDEX IF NOT EXISTS idx_credlog_worker_created ON public.worker_credentials_log (worker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credlog_admin_created ON public.worker_credentials_log (admin_id, created_at DESC) WHERE role = 'admin';
CREATE INDEX IF NOT EXISTS idx_clients_worker ON public.clients (worker_id);
CREATE INDEX IF NOT EXISTS idx_clients_admin ON public.clients (admin_id);
