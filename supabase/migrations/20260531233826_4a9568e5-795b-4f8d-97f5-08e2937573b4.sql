-- 1. Function: check if daily_cash for given scope/date is closed
CREATE OR REPLACE FUNCTION public.is_cash_closed(p_cash_date date)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_worker uuid;
  v_admin  uuid;
  v_status text;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

  IF v_worker IS NOT NULL THEN
    SELECT status INTO v_status
      FROM public.daily_cash
     WHERE cash_date = p_cash_date AND worker_id = v_worker
     LIMIT 1;
  ELSIF v_admin IS NOT NULL THEN
    SELECT status INTO v_status
      FROM public.daily_cash
     WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id = v_admin
     LIMIT 1;
  ELSE
    SELECT status INTO v_status
      FROM public.daily_cash
     WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id IS NULL
     LIMIT 1;
  END IF;

  RETURN COALESCE(v_status, 'open') = 'closed';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.is_cash_closed(date) TO authenticated;

-- 2. Recalculation: skip cancelled / renegotiated loans
CREATE OR REPLACE FUNCTION public.admin_recalculate_loans()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_updated integer := 0;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  WITH stats AS (
    SELECT
      l.id, l.status, l.remaining_balance,
      EXISTS (SELECT 1 FROM public.installments i WHERE i.loan_id = l.id AND i.status = 'overdue') AS has_overdue
    FROM public.loans l
    WHERE l.status NOT IN ('cancelled','renegotiated')
  ),
  upd AS (
    UPDATE public.loans l
    SET status = CASE
      WHEN COALESCE(l.remaining_balance, 0) <= 0.01 THEN 'paid'
      WHEN s.has_overdue THEN 'overdue'
      ELSE 'open'
    END
    FROM stats s
    WHERE s.id = l.id
      AND l.status <> CASE
        WHEN COALESCE(l.remaining_balance, 0) <= 0.01 THEN 'paid'
        WHEN s.has_overdue THEN 'overdue'
        ELSE 'open'
      END
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;
  RETURN v_updated;
END;
$function$;

-- 3. Installments recalculation: skip cancelled / renegotiated
CREATE OR REPLACE FUNCTION public.admin_recalculate_installments()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := CURRENT_DATE;
  v_updated integer := 0;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  WITH upd AS (
    UPDATE public.installments i
    SET status = CASE
      WHEN COALESCE(i.paid_amount, 0) >= i.amount THEN 'paid'
      WHEN i.due_date < v_today THEN 'overdue'
      ELSE 'pending'
    END
    WHERE i.status NOT IN ('paid','cancelled','renegotiated')
      AND i.status <> CASE
        WHEN COALESCE(i.paid_amount, 0) >= i.amount THEN 'paid'
        WHEN i.due_date < v_today THEN 'overdue'
        ELSE 'pending'
      END
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;
  RETURN v_updated;
END;
$function$;