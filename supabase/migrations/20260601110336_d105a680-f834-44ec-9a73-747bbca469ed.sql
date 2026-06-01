DROP POLICY IF EXISTS "Allow all access to loan_renegotiations" ON public.loan_renegotiations;
CREATE POLICY "Scoped access loan_renegotiations"
  ON public.loan_renegotiations
  FOR ALL
  TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(), 'admin'::public.app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(), 'admin'::public.app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR worker_id = public.get_worker_id(auth.uid())
  );

DROP POLICY IF EXISTS "Allow all access to installment_reschedules" ON public.installment_reschedules;
CREATE POLICY "Scoped access installment_reschedules"
  ON public.installment_reschedules
  FOR ALL
  TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(), 'admin'::public.app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(), 'admin'::public.app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR worker_id = public.get_worker_id(auth.uid())
  );

DROP POLICY IF EXISTS "client-attachments read" ON storage.objects;
CREATE POLICY "client-attachments read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'client-attachments'
    AND (
      public.is_super_admin(auth.uid())
      OR (public.has_role(auth.uid(), 'admin'::public.app_role)
          AND (storage.foldername(name))[1] = (public.get_admin_id(auth.uid()))::text)
      OR EXISTS (
        SELECT 1 FROM public.clients c
        WHERE c.id::text = (storage.foldername(name))[2]
          AND c.worker_id = public.get_worker_id(auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "client-attachments insert" ON storage.objects;
CREATE POLICY "client-attachments insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'client-attachments'
    AND (
      public.is_super_admin(auth.uid())
      OR (public.has_role(auth.uid(), 'admin'::public.app_role)
          AND (storage.foldername(name))[1] = (public.get_admin_id(auth.uid()))::text)
      OR EXISTS (
        SELECT 1 FROM public.clients c
        WHERE c.id::text = (storage.foldername(name))[2]
          AND c.worker_id = public.get_worker_id(auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "client-attachments update" ON storage.objects;
CREATE POLICY "client-attachments update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'client-attachments'
    AND (
      public.is_super_admin(auth.uid())
      OR (public.has_role(auth.uid(), 'admin'::public.app_role)
          AND (storage.foldername(name))[1] = (public.get_admin_id(auth.uid()))::text)
      OR EXISTS (
        SELECT 1 FROM public.clients c
        WHERE c.id::text = (storage.foldername(name))[2]
          AND c.worker_id = public.get_worker_id(auth.uid())
      )
    )
  )
  WITH CHECK (
    bucket_id = 'client-attachments'
    AND (
      public.is_super_admin(auth.uid())
      OR (public.has_role(auth.uid(), 'admin'::public.app_role)
          AND (storage.foldername(name))[1] = (public.get_admin_id(auth.uid()))::text)
      OR EXISTS (
        SELECT 1 FROM public.clients c
        WHERE c.id::text = (storage.foldername(name))[2]
          AND c.worker_id = public.get_worker_id(auth.uid())
      )
    )
  );