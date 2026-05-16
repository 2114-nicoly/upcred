-- 1. penalties
ALTER TABLE public.penalties
  ADD COLUMN IF NOT EXISTS observation TEXT,
  ADD COLUMN IF NOT EXISTS worker_id UUID REFERENCES public.workers(id),
  ADD COLUMN IF NOT EXISTS penalty_type TEXT NOT NULL DEFAULT 'fixed' CHECK (penalty_type IN ('fixed', 'percentage')),
  ADD COLUMN IF NOT EXISTS base_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS percentage_value NUMERIC,
  ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_amount NUMERIC NOT NULL DEFAULT 0;

-- 2. installment_reschedules
CREATE TABLE IF NOT EXISTS public.installment_reschedules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  installment_id UUID NOT NULL REFERENCES public.installments(id) ON DELETE CASCADE,
  loan_id UUID NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES public.workers(id),
  admin_id UUID REFERENCES public.admins(id),
  original_due_date DATE NOT NULL,
  requested_due_date DATE NOT NULL,
  approved_due_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reason TEXT,
  admin_note TEXT,
  approved_by UUID REFERENCES public.admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
ALTER TABLE public.installment_reschedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to installment_reschedules"
  ON public.installment_reschedules FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_reschedules_installment ON public.installment_reschedules(installment_id);
CREATE INDEX IF NOT EXISTS idx_reschedules_status ON public.installment_reschedules(status);
CREATE INDEX IF NOT EXISTS idx_reschedules_admin ON public.installment_reschedules(admin_id);

-- 3. installments extras
ALTER TABLE public.installments
  ADD COLUMN IF NOT EXISTS original_due_date DATE,
  ADD COLUMN IF NOT EXISTS rescheduled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reschedule_count INT NOT NULL DEFAULT 0;

-- 4. loans status_detail + loan_renegotiations
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS status_detail TEXT CHECK (status_detail IN ('active', 'renegotiated', 'renewed', 'renegociated_source') OR status_detail IS NULL);

CREATE TABLE IF NOT EXISTS public.loan_renegotiations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  original_loan_id UUID NOT NULL REFERENCES public.loans(id),
  new_loan_id UUID REFERENCES public.loans(id),
  worker_id UUID REFERENCES public.workers(id),
  admin_id UUID REFERENCES public.admins(id),
  type TEXT NOT NULL CHECK (type IN ('renegotiation', 'renewal')),
  original_remaining_balance NUMERIC NOT NULL,
  original_total_amount NUMERIC NOT NULL,
  original_installment_count INT NOT NULL,
  original_payment_type TEXT NOT NULL,
  original_interest_type TEXT NOT NULL,
  original_interest_value NUMERIC NOT NULL,
  client_paid_amount NUMERIC NOT NULL DEFAULT 0,
  absorbed_from_new NUMERIC NOT NULL DEFAULT 0,
  released_to_client NUMERIC NOT NULL DEFAULT 0,
  new_amount NUMERIC,
  new_interest_type TEXT,
  new_interest_value NUMERIC,
  new_total_amount NUMERIC,
  new_installment_count INT,
  new_payment_type TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.loan_renegotiations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to loan_renegotiations"
  ON public.loan_renegotiations FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_renegotiations_original ON public.loan_renegotiations(original_loan_id);
CREATE INDEX IF NOT EXISTS idx_renegotiations_new ON public.loan_renegotiations(new_loan_id);