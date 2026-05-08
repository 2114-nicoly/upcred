
-- 1) Clients: novos campos
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS doc_primary_type text,
  ADD COLUMN IF NOT EXISTS doc_primary_number text,
  ADD COLUMN IF NOT EXISTS doc_secondary_type text,
  ADD COLUMN IF NOT EXISTS doc_secondary_number text;

-- 2) Loans: observação
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS observation text;

-- 3) Tabela de anexos
CREATE TABLE IF NOT EXISTS public.client_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  admin_id uuid,
  worker_id uuid,
  file_name text NOT NULL,
  storage_path text NOT NULL,
  file_type text,
  file_size bigint,
  uploaded_by uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid
);

CREATE INDEX IF NOT EXISTS idx_client_attachments_client ON public.client_attachments(client_id) WHERE deleted_at IS NULL;

ALTER TABLE public.client_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Scoped access client_attachments" ON public.client_attachments;
CREATE POLICY "Scoped access client_attachments" ON public.client_attachments
FOR ALL TO authenticated
USING (
  public.is_super_admin(auth.uid())
  OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()))
  OR worker_id = public.get_worker_id(auth.uid())
)
WITH CHECK (
  public.is_super_admin(auth.uid())
  OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()))
  OR worker_id = public.get_worker_id(auth.uid())
);

-- Trigger para preencher admin_id/worker_id automaticamente baseado no cliente
CREATE OR REPLACE FUNCTION public.client_attachments_inherit_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_worker uuid; v_admin uuid;
BEGIN
  IF NEW.client_id IS NOT NULL AND (NEW.worker_id IS NULL OR NEW.admin_id IS NULL) THEN
    SELECT worker_id, admin_id INTO v_worker, v_admin FROM public.clients WHERE id = NEW.client_id;
    IF NEW.worker_id IS NULL THEN NEW.worker_id := v_worker; END IF;
    IF NEW.admin_id IS NULL THEN NEW.admin_id := v_admin; END IF;
  END IF;
  IF NEW.uploaded_by IS NULL THEN NEW.uploaded_by := auth.uid(); END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_client_attachments_inherit ON public.client_attachments;
CREATE TRIGGER trg_client_attachments_inherit
BEFORE INSERT ON public.client_attachments
FOR EACH ROW EXECUTE FUNCTION public.client_attachments_inherit_scope();

-- 4) Storage bucket privado
INSERT INTO storage.buckets (id, name, public)
VALUES ('client-attachments', 'client-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: path = {admin_id}/{client_id}/{filename}
DROP POLICY IF EXISTS "client-attachments read" ON storage.objects;
CREATE POLICY "client-attachments read" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'client-attachments' AND (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role)
        AND (storage.foldername(name))[1] = public.get_admin_id(auth.uid())::text)
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
  bucket_id = 'client-attachments' AND (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role)
        AND (storage.foldername(name))[1] = public.get_admin_id(auth.uid())::text)
    OR EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id::text = (storage.foldername(name))[2]
        AND c.worker_id = public.get_worker_id(auth.uid())
    )
  )
);

DROP POLICY IF EXISTS "client-attachments delete" ON storage.objects;
CREATE POLICY "client-attachments delete" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'client-attachments' AND (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role)
        AND (storage.foldername(name))[1] = public.get_admin_id(auth.uid())::text)
  )
);

-- 5) Atualizar admin_create_client com novos campos (compatível com chamadas antigas)
DROP FUNCTION IF EXISTS public.admin_create_client(text, text, text, uuid);
CREATE OR REPLACE FUNCTION public.admin_create_client(
  p_name text,
  p_phone text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_worker_id uuid DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_doc_primary_type text DEFAULT NULL,
  p_doc_primary_number text DEFAULT NULL,
  p_doc_secondary_type text DEFAULT NULL,
  p_doc_secondary_number text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_admin uuid;
  v_worker_admin uuid;
  v_next_code integer;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin'::app_role) OR public.is_super_admin(auth.uid())) THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;
  IF p_worker_id IS NULL THEN
    RAISE EXCEPTION 'worker_id is required when admin creates a client';
  END IF;
  SELECT parent_admin_id INTO v_worker_admin FROM public.workers WHERE id = p_worker_id AND active = true;
  IF v_worker_admin IS NULL THEN RAISE EXCEPTION 'worker not found or inactive'; END IF;

  IF NOT public.is_super_admin(auth.uid()) THEN
    v_admin := public.get_admin_id(auth.uid());
    IF v_worker_admin <> v_admin THEN RAISE EXCEPTION 'worker does not belong to your team'; END IF;
  END IF;

  SELECT COALESCE(MAX(client_code),0)+1 INTO v_next_code FROM public.clients;

  INSERT INTO public.clients (
    name, phone, notes, client_code, worker_id, admin_id, user_id,
    full_name, address, doc_primary_type, doc_primary_number, doc_secondary_type, doc_secondary_number
  )
  VALUES (
    trim(p_name), NULLIF(p_phone,''), NULLIF(p_notes,''), v_next_code, p_worker_id, v_worker_admin, auth.uid(),
    NULLIF(trim(COALESCE(p_full_name,'')),''), NULLIF(trim(COALESCE(p_address,'')),''),
    NULLIF(p_doc_primary_type,''), NULLIF(p_doc_primary_number,''),
    NULLIF(p_doc_secondary_type,''), NULLIF(p_doc_secondary_number,'')
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
