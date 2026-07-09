
CREATE TABLE public.installment_reminders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  installment_id UUID NOT NULL,
  loan_id UUID NOT NULL,
  client_id UUID,
  worker_id UUID,
  reminded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminded_by UUID,
  reminded_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_installment_reminders_installment ON public.installment_reminders(installment_id);
CREATE INDEX idx_installment_reminders_worker ON public.installment_reminders(worker_id);
CREATE INDEX idx_installment_reminders_reminded_at ON public.installment_reminders(reminded_at DESC);

GRANT SELECT, INSERT ON public.installment_reminders TO authenticated;
GRANT ALL ON public.installment_reminders TO service_role;

ALTER TABLE public.installment_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view reminders"
  ON public.installment_reminders FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can create reminders"
  ON public.installment_reminders FOR INSERT TO authenticated WITH CHECK (true);
