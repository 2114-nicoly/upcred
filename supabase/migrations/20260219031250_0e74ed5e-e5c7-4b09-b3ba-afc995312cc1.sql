
-- Routes table
CREATE TABLE public.routes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  route_number text NOT NULL UNIQUE,
  worker_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to routes" ON public.routes FOR ALL USING (true) WITH CHECK (true);

-- Route requests table
CREATE TABLE public.route_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  assigned_route_number text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.route_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to route_requests" ON public.route_requests FOR ALL USING (true) WITH CHECK (true);

-- Add route_id to clients
ALTER TABLE public.clients ADD COLUMN route_id uuid REFERENCES public.routes(id);

-- Add client_code to clients
ALTER TABLE public.clients ADD COLUMN client_code integer;

-- Add route_id to loans
ALTER TABLE public.loans ADD COLUMN route_id uuid REFERENCES public.routes(id);

-- Add observation to penalties
ALTER TABLE public.penalties ADD COLUMN observation text;
