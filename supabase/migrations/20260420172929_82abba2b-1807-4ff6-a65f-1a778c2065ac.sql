DROP POLICY IF EXISTS "Authenticated create route_request" ON public.route_requests;
CREATE POLICY "Authenticated create route_request" ON public.route_requests FOR INSERT
  TO authenticated
  WITH CHECK (status = 'pending' AND worker_name IS NOT NULL AND length(trim(worker_name)) > 0);