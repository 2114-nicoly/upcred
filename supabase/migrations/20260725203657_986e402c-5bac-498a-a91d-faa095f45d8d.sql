-- 1. Tenant scoping for route_requests
ALTER TABLE public.route_requests
  ADD COLUMN IF NOT EXISTS admin_id uuid,
  ADD COLUMN IF NOT EXISTS worker_id uuid;

UPDATE public.route_requests SET admin_id = NULL WHERE FALSE;

CREATE OR REPLACE FUNCTION public.set_route_request_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.admin_id := public.get_admin_id(auth.uid());
  NEW.worker_id := public.get_worker_id(auth.uid());
  NEW.status := 'pending';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_route_request_scope_trg ON public.route_requests;
CREATE TRIGGER set_route_request_scope_trg
BEFORE INSERT ON public.route_requests
FOR EACH ROW EXECUTE FUNCTION public.set_route_request_scope();

CREATE INDEX IF NOT EXISTS route_requests_admin_id_idx ON public.route_requests(admin_id);

DROP POLICY IF EXISTS "Admins manage route_requests" ON public.route_requests;
DROP POLICY IF EXISTS "Authenticated create route_request" ON public.route_requests;

ALTER TABLE public.route_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.route_requests TO authenticated;
GRANT ALL ON public.route_requests TO service_role;

CREATE POLICY "Admins manage own tenant route_requests"
ON public.route_requests FOR ALL TO authenticated
USING (
  public.is_super_admin(auth.uid())
  OR (public.has_role(auth.uid(), 'admin') AND admin_id IS NOT NULL AND admin_id = public.get_admin_id(auth.uid()))
)
WITH CHECK (
  public.is_super_admin(auth.uid())
  OR (public.has_role(auth.uid(), 'admin') AND admin_id IS NOT NULL AND admin_id = public.get_admin_id(auth.uid()))
);

CREATE POLICY "Workers view own route_requests"
ON public.route_requests FOR SELECT TO authenticated
USING (worker_id IS NOT NULL AND worker_id = public.get_worker_id(auth.uid()));

CREATE POLICY "Scoped users create route_request"
ON public.route_requests FOR INSERT TO authenticated
WITH CHECK (
  public.get_admin_id(auth.uid()) IS NOT NULL
  AND worker_name IS NOT NULL
  AND length(trim(worker_name)) > 0
);

-- 2. Remove open read access to realtime broadcast/presence messages.
-- The app only uses postgres_changes on public (non-private) channels,
-- which does not require a realtime.messages read policy.
DROP POLICY IF EXISTS "Authenticated users read realtime" ON realtime.messages;