
-- Ajustar trigger protetora de workers para permitir alteração via super_admin / migrações
CREATE OR REPLACE FUNCTION public.workers_protect_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('admin'::app_role,'super_admin'::app_role)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'apenas admin pode alterar trabalhadores';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE,
  nome text NOT NULL,
  email_real text NOT NULL UNIQUE,
  login_codigo text UNIQUE,
  active boolean NOT NULL DEFAULT true,
  notas text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS admins_touch ON public.admins;
CREATE TRIGGER admins_touch BEFORE UPDATE ON public.admins
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS parent_admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL;

ALTER TABLE public.clients         ADD COLUMN IF NOT EXISTS admin_id uuid;
ALTER TABLE public.loans           ADD COLUMN IF NOT EXISTS admin_id uuid;
ALTER TABLE public.cash_movements  ADD COLUMN IF NOT EXISTS admin_id uuid;
ALTER TABLE public.daily_events    ADD COLUMN IF NOT EXISTS admin_id uuid;
ALTER TABLE public.daily_cash      ADD COLUMN IF NOT EXISTS admin_id uuid;
ALTER TABLE public.cash_balance    ADD COLUMN IF NOT EXISTS admin_id uuid;
ALTER TABLE public.not_paid_marks  ADD COLUMN IF NOT EXISTS admin_id uuid;
ALTER TABLE public.penalties       ADD COLUMN IF NOT EXISTS admin_id uuid;
ALTER TABLE public.routes          ADD COLUMN IF NOT EXISTS admin_id uuid;
ALTER TABLE public.audit_logs      ADD COLUMN IF NOT EXISTS admin_id uuid;

CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'super_admin'::app_role)
$$;

CREATE OR REPLACE FUNCTION public.get_admin_id(_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT id FROM public.admins WHERE auth_user_id = _user_id LIMIT 1),
    (SELECT w.parent_admin_id FROM public.workers w WHERE w.auth_user_id = _user_id LIMIT 1)
  )
$$;

DO $$
DECLARE v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'nicknicoly2114@gmail.com' LIMIT 1;
  IF v_uid IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (v_uid, 'super_admin'::app_role) ON CONFLICT DO NOTHING;
    INSERT INTO public.user_roles (user_id, role) VALUES (v_uid, 'admin'::app_role) ON CONFLICT DO NOTHING;
  END IF;
END $$;

DO $$
DECLARE v_super uuid; v_admin_id uuid;
BEGIN
  SELECT id INTO v_super FROM auth.users WHERE email = 'nicknicoly2114@gmail.com' LIMIT 1;
  IF v_super IS NULL THEN RETURN; END IF;
  SELECT id INTO v_admin_id FROM public.admins WHERE auth_user_id = v_super LIMIT 1;
  IF v_admin_id IS NULL THEN
    INSERT INTO public.admins (auth_user_id, nome, email_real, login_codigo, created_by)
    VALUES (v_super, 'Administrador Principal', 'nicknicoly2114@gmail.com', '00001', v_super)
    RETURNING id INTO v_admin_id;
  END IF;

  UPDATE public.workers SET parent_admin_id = v_admin_id WHERE parent_admin_id IS NULL;
  UPDATE public.clients c SET admin_id = w.parent_admin_id FROM public.workers w WHERE c.worker_id = w.id AND c.admin_id IS NULL;
  UPDATE public.loans l SET admin_id = w.parent_admin_id FROM public.workers w WHERE l.worker_id = w.id AND l.admin_id IS NULL;
  UPDATE public.cash_movements cm SET admin_id = w.parent_admin_id FROM public.workers w WHERE cm.worker_id = w.id AND cm.admin_id IS NULL;
  UPDATE public.daily_events de SET admin_id = w.parent_admin_id FROM public.workers w WHERE de.worker_id = w.id AND de.admin_id IS NULL;
  UPDATE public.daily_cash dc SET admin_id = w.parent_admin_id FROM public.workers w WHERE dc.worker_id = w.id AND dc.admin_id IS NULL;
  UPDATE public.cash_balance cb SET admin_id = w.parent_admin_id FROM public.workers w WHERE cb.worker_id = w.id AND cb.admin_id IS NULL;
  UPDATE public.not_paid_marks np SET admin_id = w.parent_admin_id FROM public.workers w WHERE np.worker_id = w.id AND np.admin_id IS NULL;
  UPDATE public.penalties p SET admin_id = w.parent_admin_id FROM public.workers w WHERE p.worker_id = w.id AND p.admin_id IS NULL;
  UPDATE public.routes r SET admin_id = w.parent_admin_id FROM public.workers w WHERE r.worker_id = w.id AND r.admin_id IS NULL;
  UPDATE public.audit_logs a SET admin_id = w.parent_admin_id FROM public.workers w WHERE a.worker_id = w.id AND a.admin_id IS NULL;

  UPDATE public.clients        SET admin_id = v_admin_id WHERE admin_id IS NULL;
  UPDATE public.loans          SET admin_id = v_admin_id WHERE admin_id IS NULL;
  UPDATE public.cash_movements SET admin_id = v_admin_id WHERE admin_id IS NULL;
  UPDATE public.daily_events   SET admin_id = v_admin_id WHERE admin_id IS NULL;
  UPDATE public.daily_cash     SET admin_id = v_admin_id WHERE admin_id IS NULL;
  UPDATE public.not_paid_marks SET admin_id = v_admin_id WHERE admin_id IS NULL;
  UPDATE public.penalties      SET admin_id = v_admin_id WHERE admin_id IS NULL;
  UPDATE public.routes         SET admin_id = v_admin_id WHERE admin_id IS NULL;
  UPDATE public.audit_logs     SET admin_id = v_admin_id WHERE admin_id IS NULL;
END $$;

CREATE OR REPLACE FUNCTION public.auto_set_admin_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin uuid;
BEGIN
  IF NEW.admin_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.worker_id IS NOT NULL THEN
    SELECT parent_admin_id INTO v_admin FROM public.workers WHERE id = NEW.worker_id;
    IF v_admin IS NOT NULL THEN NEW.admin_id := v_admin; RETURN NEW; END IF;
  END IF;
  NEW.admin_id := public.get_admin_id(auth.uid());
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients','loans','cash_movements','daily_events','daily_cash','cash_balance','not_paid_marks','penalties','routes','audit_logs']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS auto_admin_id ON public.%I', t);
    EXECUTE format('CREATE TRIGGER auto_admin_id BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.auto_set_admin_id()', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "Super admin manage admins" ON public.admins;
CREATE POLICY "Super admin manage admins" ON public.admins FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid())) WITH CHECK (public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "Admin sees self" ON public.admins;
CREATE POLICY "Admin sees self" ON public.admins FOR SELECT TO authenticated
USING (auth_user_id = auth.uid());

DROP POLICY IF EXISTS "Admin or worker access clients" ON public.clients;
CREATE POLICY "Scoped access clients" ON public.clients FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()));

DROP POLICY IF EXISTS "Admin or worker access loans" ON public.loans;
CREATE POLICY "Scoped access loans" ON public.loans FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()));

DROP POLICY IF EXISTS "Admin or worker access cash_movements" ON public.cash_movements;
CREATE POLICY "Scoped access cash_movements" ON public.cash_movements FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()));

DROP POLICY IF EXISTS "Admin or worker access daily_events" ON public.daily_events;
CREATE POLICY "Scoped access daily_events" ON public.daily_events FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()));

DROP POLICY IF EXISTS "Admin or worker access daily_cash" ON public.daily_cash;
CREATE POLICY "Scoped access daily_cash" ON public.daily_cash FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()));

DROP POLICY IF EXISTS "Admin or worker read cash_balance" ON public.cash_balance;
DROP POLICY IF EXISTS "Admin or worker write cash_balance" ON public.cash_balance;
CREATE POLICY "Scoped access cash_balance" ON public.cash_balance FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()));

DROP POLICY IF EXISTS "Admin or worker access not_paid_marks" ON public.not_paid_marks;
CREATE POLICY "Scoped access not_paid_marks" ON public.not_paid_marks FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()));

DROP POLICY IF EXISTS "Admin or worker access penalties" ON public.penalties;
CREATE POLICY "Scoped access penalties" ON public.penalties FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()));

DROP POLICY IF EXISTS "Admin or worker access routes" ON public.routes;
CREATE POLICY "Scoped access routes" ON public.routes FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR worker_id = public.get_worker_id(auth.uid()));

DROP POLICY IF EXISTS "Admin sees all audit logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Worker sees own audit logs" ON public.audit_logs;
CREATE POLICY "Scoped read audit_logs" ON public.audit_logs FOR SELECT TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid())) OR (user_id = auth.uid() AND worker_id = public.get_worker_id(auth.uid())));

DROP POLICY IF EXISTS "Admins manage workers" ON public.workers;
DROP POLICY IF EXISTS "Workers see self" ON public.workers;
CREATE POLICY "Super admin manage workers" ON public.workers FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid())) WITH CHECK (public.is_super_admin(auth.uid()));
CREATE POLICY "Admin manage own workers" ON public.workers FOR ALL TO authenticated
USING (public.has_role(auth.uid(),'admin'::app_role) AND parent_admin_id = public.get_admin_id(auth.uid()))
WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) AND parent_admin_id = public.get_admin_id(auth.uid()));
CREATE POLICY "Worker sees self" ON public.workers FOR SELECT TO authenticated
USING (auth_user_id = auth.uid());

DROP POLICY IF EXISTS "Admin manage client_transfers" ON public.client_transfers;
CREATE POLICY "Scoped client_transfers" ON public.client_transfers FOR ALL TO authenticated
USING (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND (
  EXISTS(SELECT 1 FROM public.workers w WHERE w.id = from_worker_id AND w.parent_admin_id = public.get_admin_id(auth.uid()))
  OR EXISTS(SELECT 1 FROM public.workers w WHERE w.id = to_worker_id AND w.parent_admin_id = public.get_admin_id(auth.uid()))
)))
WITH CHECK (public.is_super_admin(auth.uid()) OR (public.has_role(auth.uid(),'admin'::app_role) AND
  EXISTS(SELECT 1 FROM public.workers w WHERE w.id = to_worker_id AND w.parent_admin_id = public.get_admin_id(auth.uid()))
));

CREATE OR REPLACE FUNCTION public.admin_register_worker(p_nome text, p_login_codigo text, p_synthetic_email text, p_auth_user_id uuid, p_notas text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_worker_id uuid; v_parent_admin uuid;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin'::app_role) OR public.is_super_admin(auth.uid())) THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;
  v_parent_admin := public.get_admin_id(auth.uid());
  INSERT INTO public.workers (auth_user_id, login_codigo, synthetic_email, nome, notas, created_by, active, parent_admin_id)
  VALUES (p_auth_user_id, p_login_codigo, p_synthetic_email, p_nome, p_notas, auth.uid(), true, v_parent_admin)
  RETURNING id INTO v_worker_id;
  INSERT INTO public.user_roles (user_id, role) VALUES (p_auth_user_id, 'trabalhador'::app_role) ON CONFLICT DO NOTHING;
  RETURN v_worker_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.super_admin_register_admin(p_nome text, p_email_real text, p_login_codigo text, p_auth_user_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN RAISE EXCEPTION 'permission denied: super_admin required'; END IF;
  INSERT INTO public.admins (auth_user_id, nome, email_real, login_codigo, active, created_by)
  VALUES (p_auth_user_id, p_nome, p_email_real, p_login_codigo, true, auth.uid())
  RETURNING id INTO v_id;
  INSERT INTO public.user_roles (user_id, role) VALUES (p_auth_user_id, 'admin'::app_role) ON CONFLICT DO NOTHING;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_list_workers()
RETURNS TABLE(id uuid, nome text, login_codigo text, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.id, w.nome, w.login_codigo, w.active FROM public.workers w
  WHERE public.is_super_admin(auth.uid())
     OR (public.has_role(auth.uid(),'admin'::app_role) AND w.parent_admin_id = public.get_admin_id(auth.uid()))
  ORDER BY w.active DESC, w.nome ASC;
$$;

CREATE OR REPLACE FUNCTION public.super_admin_list_admins()
RETURNS TABLE(id uuid, nome text, email_real text, login_codigo text, active boolean, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.nome, a.email_real, a.login_codigo, a.active, a.created_at FROM public.admins a
  WHERE public.is_super_admin(auth.uid()) ORDER BY a.active DESC, a.nome ASC;
$$;

CREATE OR REPLACE FUNCTION public.log_audit(p_action text, p_entity text, p_entity_id uuid DEFAULT NULL, p_old jsonb DEFAULT NULL, p_new jsonb DEFAULT NULL, p_obs text DEFAULT NULL, p_worker_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_role text; v_worker uuid; v_admin uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  IF public.is_super_admin(auth.uid()) THEN v_role := 'super_admin';
  ELSIF public.has_role(auth.uid(),'admin'::app_role) THEN v_role := 'admin';
  ELSE v_role := 'trabalhador'; END IF;
  v_worker := COALESCE(p_worker_id, public.get_worker_id(auth.uid()));
  v_admin := public.get_admin_id(auth.uid());
  IF v_admin IS NULL AND v_worker IS NOT NULL THEN
    SELECT parent_admin_id INTO v_admin FROM public.workers WHERE id = v_worker;
  END IF;
  INSERT INTO public.audit_logs (user_id, user_role, worker_id, admin_id, action_type, entity_type, entity_id, old_value, new_value, observation)
  VALUES (auth.uid(), v_role, v_worker, v_admin, p_action, p_entity, p_entity_id, p_old, p_new, p_obs)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_loan_payment(p_loan_id uuid, p_amount numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_current numeric; v_new numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'payment amount must be greater than zero'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.loans WHERE id = p_loan_id AND (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR worker_id = public.get_worker_id(auth.uid()) OR user_id = auth.uid()
  )) THEN RAISE EXCEPTION 'access denied'; END IF;
  SELECT remaining_balance INTO v_current FROM public.loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'loan not found'; END IF;
  v_new := GREATEST(0, v_current - p_amount);
  UPDATE public.loans SET remaining_balance = v_new,
    status = CASE WHEN v_new <= 0.01 THEN 'paid' WHEN status='paid' THEN 'open' ELSE status END
  WHERE id = p_loan_id;
  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_loan_payment(p_loan_id uuid, p_amount numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_current numeric; v_total numeric; v_new numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'payment amount must be greater than zero'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.loans WHERE id = p_loan_id AND (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR worker_id = public.get_worker_id(auth.uid()) OR user_id = auth.uid()
  )) THEN RAISE EXCEPTION 'access denied'; END IF;
  SELECT remaining_balance, total_amount INTO v_current, v_total FROM public.loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'loan not found'; END IF;
  v_new := LEAST(COALESCE(v_total,0), v_current + p_amount);
  UPDATE public.loans SET remaining_balance = v_new,
    status = CASE WHEN v_new <= 0.01 THEN 'paid' WHEN status='paid' THEN 'open' ELSE status END
  WHERE id = p_loan_id;
  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_transfer_client(p_client_id uuid, p_to_worker_id uuid, p_observation text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_from_worker uuid; v_active_loan uuid; v_transfer_id uuid; v_dest_admin uuid; v_my_admin uuid;
BEGIN
  IF NOT (public.is_super_admin(auth.uid()) OR public.has_role(auth.uid(),'admin'::app_role)) THEN
    RAISE EXCEPTION 'permission denied';
  END IF;
  SELECT parent_admin_id INTO v_dest_admin FROM public.workers WHERE id = p_to_worker_id AND active = true;
  IF v_dest_admin IS NULL THEN RAISE EXCEPTION 'destination worker not found or inactive'; END IF;
  IF NOT public.is_super_admin(auth.uid()) THEN
    v_my_admin := public.get_admin_id(auth.uid());
    IF v_dest_admin <> v_my_admin THEN RAISE EXCEPTION 'cannot transfer to a worker outside your team'; END IF;
  END IF;
  SELECT worker_id INTO v_from_worker FROM public.clients WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'client not found'; END IF;
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
$$;
