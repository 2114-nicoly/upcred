-- Server-side admin-enforced bulk maintenance RPCs.
-- All three functions raise an exception unless the caller has the 'admin' role.

CREATE OR REPLACE FUNCTION public.admin_recalculate_installments()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    WHERE i.status <> 'paid'
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
$$;

CREATE OR REPLACE FUNCTION public.admin_recalculate_loans()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  WITH stats AS (
    SELECT
      l.id,
      l.status,
      l.remaining_balance,
      EXISTS (
        SELECT 1 FROM public.installments i
        WHERE i.loan_id = l.id AND i.status = 'overdue'
      ) AS has_overdue
    FROM public.loans l
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
$$;

CREATE OR REPLACE FUNCTION public.admin_assign_client_codes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer := 0;
  v_next integer;
  r record;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  FOR r IN
    SELECT id FROM public.clients
    WHERE client_code IS NULL
    ORDER BY created_at ASC
  LOOP
    SELECT COALESCE(MAX(client_code), 0) + 1 INTO v_next FROM public.clients;
    UPDATE public.clients SET client_code = v_next WHERE id = r.id;
    v_updated := v_updated + 1;
  END LOOP;

  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_recalculate_installments() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_recalculate_loans() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_assign_client_codes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_recalculate_installments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_recalculate_loans() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_client_codes() TO authenticated;