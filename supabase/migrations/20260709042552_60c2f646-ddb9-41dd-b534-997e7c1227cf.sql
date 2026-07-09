
-- 1) Deduplicate: keep latest reminder per installment_id
WITH ranked AS (
  SELECT id, installment_id,
         row_number() OVER (PARTITION BY installment_id ORDER BY reminded_at DESC, created_at DESC) AS rn
  FROM public.installment_reminders
)
DELETE FROM public.installment_reminders r
USING ranked
WHERE r.id = ranked.id AND ranked.rn > 1;

-- 2) UNIQUE on installment_id (enables upsert on conflict)
ALTER TABLE public.installment_reminders
  ADD CONSTRAINT installment_reminders_installment_id_key UNIQUE (installment_id);

-- 3) Foreign keys (match integrity pattern used by other tables)
ALTER TABLE public.installment_reminders
  ADD CONSTRAINT installment_reminders_installment_id_fkey
    FOREIGN KEY (installment_id) REFERENCES public.installments(id) ON DELETE CASCADE,
  ADD CONSTRAINT installment_reminders_loan_id_fkey
    FOREIGN KEY (loan_id) REFERENCES public.loans(id) ON DELETE CASCADE,
  ADD CONSTRAINT installment_reminders_client_id_fkey
    FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL,
  ADD CONSTRAINT installment_reminders_worker_id_fkey
    FOREIGN KEY (worker_id) REFERENCES public.workers(id) ON DELETE SET NULL;

-- 4) Grants (align with app roles)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.installment_reminders TO authenticated;
GRANT ALL ON public.installment_reminders TO service_role;

-- 5) RLS: replace permissive policies with tenant/worker-scoped ones
DROP POLICY IF EXISTS "Authenticated users can view reminders" ON public.installment_reminders;
DROP POLICY IF EXISTS "Authenticated users can create reminders" ON public.installment_reminders;

CREATE POLICY "reminders_select_scoped"
ON public.installment_reminders FOR SELECT
TO authenticated
USING (
  public.is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = installment_reminders.loan_id
      AND (
        (public.has_role(auth.uid(),'admin'::app_role) AND l.admin_id = public.get_admin_id(auth.uid()))
        OR l.worker_id = public.get_worker_id(auth.uid())
      )
  )
);

CREATE POLICY "reminders_insert_scoped"
ON public.installment_reminders FOR INSERT
TO authenticated
WITH CHECK (
  public.is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = installment_reminders.loan_id
      AND (
        (public.has_role(auth.uid(),'admin'::app_role) AND l.admin_id = public.get_admin_id(auth.uid()))
        OR l.worker_id = public.get_worker_id(auth.uid())
      )
  )
);

CREATE POLICY "reminders_update_scoped"
ON public.installment_reminders FOR UPDATE
TO authenticated
USING (
  public.is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = installment_reminders.loan_id
      AND (
        (public.has_role(auth.uid(),'admin'::app_role) AND l.admin_id = public.get_admin_id(auth.uid()))
        OR l.worker_id = public.get_worker_id(auth.uid())
      )
  )
)
WITH CHECK (
  public.is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = installment_reminders.loan_id
      AND (
        (public.has_role(auth.uid(),'admin'::app_role) AND l.admin_id = public.get_admin_id(auth.uid()))
        OR l.worker_id = public.get_worker_id(auth.uid())
      )
  )
);

CREATE POLICY "reminders_delete_admin"
ON public.installment_reminders FOR DELETE
TO authenticated
USING (
  public.is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = installment_reminders.loan_id
      AND public.has_role(auth.uid(),'admin'::app_role)
      AND l.admin_id = public.get_admin_id(auth.uid())
  )
);
