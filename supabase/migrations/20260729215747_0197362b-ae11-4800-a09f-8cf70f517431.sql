CREATE TABLE public.worker_creation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL,
  requested_by uuid,
  worker_name text NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  rejection_reason text,
  created_worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_creation_requests_status_chk CHECK (status IN ('pending','processing','approved','rejected')),
  CONSTRAINT worker_creation_requests_worker_after_approval_chk CHECK (created_worker_id IS NULL OR status = 'approved')
);

GRANT SELECT, INSERT, UPDATE ON public.worker_creation_requests TO authenticated;
GRANT ALL ON public.worker_creation_requests TO service_role;

ALTER TABLE public.worker_creation_requests ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_wcr_admin_id ON public.worker_creation_requests(admin_id);
CREATE INDEX idx_wcr_status ON public.worker_creation_requests(status);
CREATE INDEX idx_wcr_requested_at ON public.worker_creation_requests(requested_at DESC);

-- Admin: cria somente para a própria empresa
CREATE POLICY "wcr_admin_insert_own_company"
ON public.worker_creation_requests FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'admin')
  AND admin_id = public.get_admin_id(auth.uid())
  AND requested_by = auth.uid()
  AND status = 'pending'
  AND created_worker_id IS NULL
  AND reviewed_by IS NULL
  AND reviewed_at IS NULL
  AND rejection_reason IS NULL
);

-- Admin: vê somente as suas
CREATE POLICY "wcr_admin_select_own_company"
ON public.worker_creation_requests FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  AND admin_id = public.get_admin_id(auth.uid())
);

-- SuperAdmin: vê tudo
CREATE POLICY "wcr_super_admin_select_all"
ON public.worker_creation_requests FOR SELECT TO authenticated
USING (public.is_super_admin(auth.uid()));

-- SuperAdmin: pode responder (negar agora, aprovar na próxima etapa)
CREATE POLICY "wcr_super_admin_update"
ON public.worker_creation_requests FOR UPDATE TO authenticated
USING (public.is_super_admin(auth.uid()) AND status IN ('pending','processing'))
WITH CHECK (public.is_super_admin(auth.uid()));

CREATE TRIGGER trg_wcr_touch_updated_at
BEFORE UPDATE ON public.worker_creation_requests
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();