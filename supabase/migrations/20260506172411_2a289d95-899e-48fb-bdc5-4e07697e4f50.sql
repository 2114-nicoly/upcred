
-- Trigger function: auto-fill worker_id on insert
CREATE OR REPLACE FUNCTION public.auto_set_worker_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_worker uuid;
BEGIN
  IF NEW.worker_id IS NOT NULL THEN
    -- if non-admin tries to set a worker_id != their own, force their own
    IF NOT public.has_role(auth.uid(), 'admin') THEN
      v_worker := public.get_worker_id(auth.uid());
      NEW.worker_id := v_worker;
    END IF;
    RETURN NEW;
  END IF;

  v_worker := public.get_worker_id(auth.uid());
  NEW.worker_id := v_worker; -- NULL is OK for admin
  RETURN NEW;
END;
$$;

-- Apply trigger to each operational table
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'clients','loans','cash_movements','daily_events','daily_cash',
    'not_paid_marks','penalties','routes'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_auto_worker_id ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_auto_worker_id BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.auto_set_worker_id()', t);
  END LOOP;
END$$;

-- Auto-create cash_balance row when a worker is created
CREATE OR REPLACE FUNCTION public.create_cash_balance_for_worker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.cash_balance (worker_id, available_cash, money_lent, interest_receivable, penalty_receivable)
  VALUES (NEW.id, 0, 0, 0, 0)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workers_create_cash_balance ON public.workers;
CREATE TRIGGER trg_workers_create_cash_balance
  AFTER INSERT ON public.workers
  FOR EACH ROW EXECUTE FUNCTION public.create_cash_balance_for_worker();

-- Replace update_cash_balance_atomic so it works for both admin and worker
-- (writes to the row that matches the caller's worker_id, or admin's NULL row)
CREATE OR REPLACE FUNCTION public.update_cash_balance_atomic(
  p_available_cash numeric DEFAULT 0,
  p_money_lent numeric DEFAULT 0,
  p_interest_receivable numeric DEFAULT 0,
  p_penalty_receivable numeric DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_worker uuid;
  v_is_admin boolean;
BEGIN
  v_is_admin := public.has_role(auth.uid(), 'admin');
  v_worker := public.get_worker_id(auth.uid());

  IF NOT v_is_admin AND v_worker IS NULL THEN
    RAISE EXCEPTION 'no worker linked to current user';
  END IF;

  -- ensure a row exists for this scope
  INSERT INTO public.cash_balance (worker_id, available_cash, money_lent, interest_receivable, penalty_receivable)
  VALUES (v_worker, 0, 0, 0, 0)
  ON CONFLICT DO NOTHING;

  UPDATE public.cash_balance
  SET
    available_cash      = available_cash      + p_available_cash,
    money_lent          = money_lent          + p_money_lent,
    interest_receivable = interest_receivable + p_interest_receivable,
    penalty_receivable  = penalty_receivable  + p_penalty_receivable,
    updated_at = now()
  WHERE worker_id IS NOT DISTINCT FROM v_worker;
END;
$$;

-- Ensure an admin cash_balance row exists for the global/admin scope
INSERT INTO public.cash_balance (worker_id, available_cash, money_lent, interest_receivable, penalty_receivable)
VALUES (NULL, 0, 0, 0, 0)
ON CONFLICT DO NOTHING;
