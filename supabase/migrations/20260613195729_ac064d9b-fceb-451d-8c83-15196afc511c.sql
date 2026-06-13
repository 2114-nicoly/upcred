ALTER TABLE public.loans DROP CONSTRAINT IF EXISTS loans_status_check;
ALTER TABLE public.loans ADD CONSTRAINT loans_status_check
  CHECK (status IN ('open', 'overdue', 'paid', 'cancelled', 'renegotiated'));

ALTER TABLE public.installments DROP CONSTRAINT IF EXISTS installments_status_check;
ALTER TABLE public.installments ADD CONSTRAINT installments_status_check
  CHECK (status IN ('pending', 'partial', 'overdue', 'paid', 'cancelled', 'renegotiated'));