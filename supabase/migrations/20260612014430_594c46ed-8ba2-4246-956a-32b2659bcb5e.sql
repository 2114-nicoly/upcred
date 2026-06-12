
-- 1) Tenant-scope admin maintenance RPCs
CREATE OR REPLACE FUNCTION public.admin_recalculate_installments()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_today date := CURRENT_DATE;
  v_updated integer := 0;
  v_admin uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;
  v_admin := public.get_admin_id(auth.uid());
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'permission denied: admin scope not found';
  END IF;

  WITH upd AS (
    UPDATE public.installments i
    SET status = CASE
      WHEN COALESCE(i.paid_amount, 0) >= i.amount THEN 'paid'
      WHEN i.due_date < v_today THEN 'overdue'
      ELSE 'pending'
    END
    FROM public.loans l
    WHERE i.loan_id = l.id
      AND l.admin_id = v_admin
      AND i.status NOT IN ('paid','cancelled','renegotiated')
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
SET search_path TO 'public'
AS $$
DECLARE
  v_updated integer := 0;
  v_admin uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;
  v_admin := public.get_admin_id(auth.uid());
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'permission denied: admin scope not found';
  END IF;

  WITH stats AS (
    SELECT
      l.id, l.status, l.remaining_balance,
      EXISTS (SELECT 1 FROM public.installments i WHERE i.loan_id = l.id AND i.status = 'overdue') AS has_overdue
    FROM public.loans l
    WHERE l.status NOT IN ('cancelled','renegotiated')
      AND l.admin_id = v_admin
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
      AND l.admin_id = v_admin
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
SET search_path TO 'public'
AS $$
DECLARE
  v_updated integer := 0;
  v_next integer;
  v_admin uuid;
  r record;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;
  v_admin := public.get_admin_id(auth.uid());
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'permission denied: admin scope not found';
  END IF;

  FOR r IN
    SELECT id FROM public.clients
    WHERE client_code IS NULL AND admin_id = v_admin
    ORDER BY created_at ASC
  LOOP
    SELECT COALESCE(MAX(client_code), 0) + 1 INTO v_next
      FROM public.clients WHERE admin_id = v_admin;
    UPDATE public.clients SET client_code = v_next WHERE id = r.id;
    v_updated := v_updated + 1;
  END LOOP;

  RETURN v_updated;
END;
$$;

-- 2) Fix storage policies: replace storage.foldername(c.name) with storage.foldername(name)
DROP POLICY IF EXISTS "client-attachments read" ON storage.objects;
DROP POLICY IF EXISTS "client-attachments insert" ON storage.objects;
DROP POLICY IF EXISTS "client-attachments update" ON storage.objects;

CREATE POLICY "client-attachments read" ON storage.objects
FOR SELECT USING (
  bucket_id = 'client-attachments' AND (
    is_super_admin(auth.uid())
    OR (has_role(auth.uid(), 'admin'::app_role) AND ((storage.foldername(name))[1] = (get_admin_id(auth.uid()))::text))
    OR EXISTS (
      SELECT 1 FROM clients c
      WHERE (c.id)::text = (storage.foldername(name))[2]
        AND c.worker_id = get_worker_id(auth.uid())
    )
  )
);

CREATE POLICY "client-attachments insert" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'client-attachments' AND (
    is_super_admin(auth.uid())
    OR (has_role(auth.uid(), 'admin'::app_role) AND ((storage.foldername(name))[1] = (get_admin_id(auth.uid()))::text))
    OR EXISTS (
      SELECT 1 FROM clients c
      WHERE (c.id)::text = (storage.foldername(name))[2]
        AND c.worker_id = get_worker_id(auth.uid())
    )
  )
);

CREATE POLICY "client-attachments update" ON storage.objects
FOR UPDATE USING (
  bucket_id = 'client-attachments' AND (
    is_super_admin(auth.uid())
    OR (has_role(auth.uid(), 'admin'::app_role) AND ((storage.foldername(name))[1] = (get_admin_id(auth.uid()))::text))
    OR EXISTS (
      SELECT 1 FROM clients c
      WHERE (c.id)::text = (storage.foldername(name))[2]
        AND c.worker_id = get_worker_id(auth.uid())
    )
  )
) WITH CHECK (
  bucket_id = 'client-attachments' AND (
    is_super_admin(auth.uid())
    OR (has_role(auth.uid(), 'admin'::app_role) AND ((storage.foldername(name))[1] = (get_admin_id(auth.uid()))::text))
    OR EXISTS (
      SELECT 1 FROM clients c
      WHERE (c.id)::text = (storage.foldername(name))[2]
        AND c.worker_id = get_worker_id(auth.uid())
    )
  )
);

-- 3) Schedule daily redaction of old temporary passwords
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule('redact-old-credentials');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'redact-old-credentials',
  '0 3 * * *',
  $$ SELECT public.redact_old_credentials_log(); $$
);
