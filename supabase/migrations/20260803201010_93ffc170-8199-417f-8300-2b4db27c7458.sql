CREATE OR REPLACE FUNCTION public.cash_lock_guard_loans()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Empréstimo importado em andamento é apenas histórico: não gera saída de
    -- caixa e por isso pode ter loan_date antiga.
    IF COALESCE(NEW.is_imported_ongoing, false) THEN
      RETURN NEW;
    END IF;
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.loan_date, CURRENT_DATE);
    PERFORM public._assert_active_cash_date(v_date, v_worker, v_admin);
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.cash_lock_guard_loans() FROM PUBLIC, anon, authenticated;