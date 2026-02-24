
-- Table for daily cash closure records
CREATE TABLE public.daily_cash (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cash_date date NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'open',
  total_received numeric NOT NULL DEFAULT 0,
  total_penalty_received numeric NOT NULL DEFAULT 0,
  total_not_paid_count integer NOT NULL DEFAULT 0,
  total_items_treated integer NOT NULL DEFAULT 0,
  summary text,
  closed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.daily_cash ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to daily_cash"
  ON public.daily_cash FOR ALL
  USING (true)
  WITH CHECK (true);

-- Table for "não pagou" marks (separate from payments)
CREATE TABLE public.not_paid_marks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  mark_date date NOT NULL,
  installment_id uuid NOT NULL REFERENCES public.installments(id),
  loan_id uuid NOT NULL REFERENCES public.loans(id),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  observation text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.not_paid_marks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to not_paid_marks"
  ON public.not_paid_marks FOR ALL
  USING (true)
  WITH CHECK (true);
