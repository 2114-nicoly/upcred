
DROP POLICY IF EXISTS "client-attachments read"   ON storage.objects;
DROP POLICY IF EXISTS "client-attachments insert" ON storage.objects;
DROP POLICY IF EXISTS "client-attachments update" ON storage.objects;
DROP POLICY IF EXISTS "client-attachments delete" ON storage.objects;

CREATE POLICY "client-attachments read" ON storage.objects
FOR SELECT TO authenticated USING (
  bucket_id = 'client-attachments' AND (
    public.is_super_admin(auth.uid())
    OR (storage.foldername(name))[1] = public.get_admin_id(auth.uid())::text
  )
);

CREATE POLICY "client-attachments insert" ON storage.objects
FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'client-attachments' AND (
    public.is_super_admin(auth.uid())
    OR (storage.foldername(name))[1] = public.get_admin_id(auth.uid())::text
  )
);

CREATE POLICY "client-attachments update" ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'client-attachments' AND (
    public.is_super_admin(auth.uid())
    OR (storage.foldername(name))[1] = public.get_admin_id(auth.uid())::text
  )
)
WITH CHECK (
  bucket_id = 'client-attachments' AND (
    public.is_super_admin(auth.uid())
    OR (storage.foldername(name))[1] = public.get_admin_id(auth.uid())::text
  )
);

CREATE POLICY "client-attachments delete" ON storage.objects
FOR DELETE TO authenticated USING (
  bucket_id = 'client-attachments' AND (
    public.is_super_admin(auth.uid())
    OR (storage.foldername(name))[1] = public.get_admin_id(auth.uid())::text
  )
);
