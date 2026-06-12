CREATE OR REPLACE FUNCTION public.cash_lock_guard_loans()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_worker uuid;
  v_admin uuid;
  v_date date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Empréstimo em andamento (importado) não exige caixa aberto
    IF COALESCE(NEW.is_imported_ongoing, false) = true THEN
      RETURN NEW;
    END IF;

    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.loan_date, CURRENT_DATE);

    IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de criar este empréstimo.', v_date
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT public._cash_is_open_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) ainda não foi aberto. Abra o caixa antes de criar este empréstimo.', v_date
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;
