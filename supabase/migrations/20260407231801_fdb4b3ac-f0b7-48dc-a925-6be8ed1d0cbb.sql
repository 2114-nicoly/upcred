
CREATE TABLE public.daily_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cash_date date NOT NULL DEFAULT CURRENT_DATE,
  event_type text NOT NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  loan_id uuid REFERENCES public.loans(id) ON DELETE SET NULL,
  installment_id uuid REFERENCES public.installments(id) ON DELETE SET NULL,
  amount_in numeric NOT NULL DEFAULT 0,
  amount_out numeric NOT NULL DEFAULT 0,
  observation text,
  origin text DEFAULT 'rota',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.daily_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to daily_events"
ON public.daily_events
FOR ALL
USING (true)
WITH CHECK (true);

CREATE INDEX idx_daily_events_cash_date ON public.daily_events (cash_date);
CREATE INDEX idx_daily_events_loan_id ON public.daily_events (loan_id);
CREATE INDEX idx_daily_events_client_id ON public.daily_events (client_id);
