-- 1. Ensure auto-set triggers are active on all relevant tables
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['clients','loans','daily_events','cash_movements','not_paid_marks','penalties','daily_cash','routes'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_auto_set_worker_id ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_auto_set_worker_id BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.auto_set_worker_id()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_auto_set_admin_id ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_auto_set_admin_id BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.auto_set_admin_id()', t);
  END LOOP;
END $$;

-- 2. Loans inherit worker_id and admin_id from client
CREATE OR REPLACE FUNCTION public.loans_inherit_from_client()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_worker uuid; v_admin uuid;
BEGIN
  IF NEW.client_id IS NOT NULL AND (NEW.worker_id IS NULL OR NEW.admin_id IS NULL) THEN
    SELECT worker_id, admin_id INTO v_worker, v_admin FROM public.clients WHERE id = NEW.client_id;
    IF NEW.worker_id IS NULL THEN NEW.worker_id := v_worker; END IF;
    IF NEW.admin_id IS NULL THEN NEW.admin_id := v_admin; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_loans_inherit_from_client ON public.loans;
CREATE TRIGGER trg_loans_inherit_from_client
  BEFORE INSERT ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.loans_inherit_from_client();

-- 3. Manage remaining balance trigger (was orphan function)
DROP TRIGGER IF EXISTS trg_manage_loan_remaining_balance ON public.loans;
CREATE TRIGGER trg_manage_loan_remaining_balance
  BEFORE INSERT OR UPDATE ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.manage_loan_remaining_balance();

-- 4. Backfill admin_id on records that have worker_id but no admin_id
UPDATE public.clients c SET admin_id = w.parent_admin_id
  FROM public.workers w WHERE c.worker_id = w.id AND c.admin_id IS NULL AND w.parent_admin_id IS NOT NULL;
UPDATE public.loans l SET admin_id = w.parent_admin_id
  FROM public.workers w WHERE l.worker_id = w.id AND l.admin_id IS NULL AND w.parent_admin_id IS NOT NULL;
UPDATE public.loans l SET worker_id = c.worker_id, admin_id = COALESCE(l.admin_id, c.admin_id)
  FROM public.clients c WHERE l.client_id = c.id AND l.worker_id IS NULL AND c.worker_id IS NOT NULL;
UPDATE public.daily_events de SET admin_id = w.parent_admin_id
  FROM public.workers w WHERE de.worker_id = w.id AND de.admin_id IS NULL AND w.parent_admin_id IS NOT NULL;
UPDATE public.cash_movements cm SET admin_id = w.parent_admin_id
  FROM public.workers w WHERE cm.worker_id = w.id AND cm.admin_id IS NULL AND w.parent_admin_id IS NOT NULL;

-- 5. RPC: admin creates client for a specific worker
CREATE OR REPLACE FUNCTION public.admin_create_client(
  p_name text, p_phone text DEFAULT NULL, p_notes text DEFAULT NULL, p_worker_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_admin uuid;
  v_worker_admin uuid;
  v_next_code integer;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin'::app_role) OR public.is_super_admin(auth.uid())) THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;
  IF p_worker_id IS NULL THEN
    RAISE EXCEPTION 'worker_id is required when admin creates a client';
  END IF;
  SELECT parent_admin_id INTO v_worker_admin FROM public.workers WHERE id = p_worker_id AND active = true;
  IF v_worker_admin IS NULL THEN RAISE EXCEPTION 'worker not found or inactive'; END IF;

  IF NOT public.is_super_admin(auth.uid()) THEN
    v_admin := public.get_admin_id(auth.uid());
    IF v_worker_admin <> v_admin THEN RAISE EXCEPTION 'worker does not belong to your team'; END IF;
  END IF;

  SELECT COALESCE(MAX(client_code),0)+1 INTO v_next_code FROM public.clients;

  INSERT INTO public.clients (name, phone, notes, client_code, worker_id, admin_id, user_id)
  VALUES (trim(p_name), NULLIF(p_phone,''), NULLIF(p_notes,''), v_next_code, p_worker_id, v_worker_admin, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;