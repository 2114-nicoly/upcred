-- Fix 1: search_path em touch_updated_at
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- Fix 2: route_requests só autenticados podem criar
DROP POLICY IF EXISTS "Anyone can create route_request" ON public.route_requests;
CREATE POLICY "Authenticated create route_request" ON public.route_requests FOR INSERT
  TO authenticated
  WITH CHECK (true);