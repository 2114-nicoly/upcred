-- Backend cash-lock enforcement: prevent financial mutations when daily_cash is closed
-- for the relevant worker/admin scope and date.

CREATE OR REPLACE FUNCTION public._cash_is_closed_for(p_cash_date date, p_worker_id uuid, p_admin_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.daily_cash dc
    WHERE dc.cash_date = p_cash_date
      AND dc.status = 'closed'
      AND (
        (p_worker_id IS NOT NULL AND dc.worker_id = p_worker_id)
        OR (p_worker_id IS NULL AND dc.worker_id IS NULL AND dc.admin_id IS NOT DISTINCT FROM p_admin_id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_cash_movements()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker := OLD.worker_id; v_admin := OLD.admin_id; v_date := OLD.cash_date;
  ELSE
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.cash_date, CURRENT_DATE);
    -- On UPDATE, allow setting reversed_at by admins/owners even if closed? No: require reopen.
  END IF;
  IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_daily_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date; v_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker := OLD.worker_id; v_admin := OLD.admin_id; v_date := OLD.cash_date; v_type := OLD.event_type;
  ELSE
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.cash_date, CURRENT_DATE);
    v_type   := NEW.event_type;
  END IF;
  -- Only block financial events
  IF v_type IN ('pagamento','recebimento_multa','emprestimo_novo','renovacao','renegociacao','entrada_manual','saida_manual','quitacao') THEN
    IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_not_paid_marks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker := OLD.worker_id; v_admin := OLD.admin_id; v_date := OLD.mark_date;
  ELSE
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.mark_date, CURRENT_DATE);
  END IF;
  IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_loans()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.loan_date, CURRENT_DATE);
    IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de criar este empréstimo.', v_date
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cash_lock_cash_movements ON public.cash_movements;
CREATE TRIGGER trg_cash_lock_cash_movements
  BEFORE INSERT OR UPDATE OR DELETE ON public.cash_movements
  FOR EACH ROW EXECUTE FUNCTION public.cash_lock_guard_cash_movements();

DROP TRIGGER IF EXISTS trg_cash_lock_daily_events ON public.daily_events;
CREATE TRIGGER trg_cash_lock_daily_events
  BEFORE INSERT OR UPDATE OR DELETE ON public.daily_events
  FOR EACH ROW EXECUTE FUNCTION public.cash_lock_guard_daily_events();

DROP TRIGGER IF EXISTS trg_cash_lock_not_paid_marks ON public.not_paid_marks;
CREATE TRIGGER trg_cash_lock_not_paid_marks
  BEFORE INSERT OR UPDATE OR DELETE ON public.not_paid_marks
  FOR EACH ROW EXECUTE FUNCTION public.cash_lock_guard_not_paid_marks();

DROP TRIGGER IF EXISTS trg_cash_lock_loans ON public.loans;
CREATE TRIGGER trg_cash_lock_loans
  BEFORE INSERT ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.cash_lock_guard_loans();
