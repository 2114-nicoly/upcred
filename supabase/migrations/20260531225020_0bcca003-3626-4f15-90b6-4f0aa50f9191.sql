
ALTER TABLE public.daily_cash DROP CONSTRAINT IF EXISTS daily_cash_cash_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS daily_cash_uq_worker
  ON public.daily_cash (cash_date, worker_id)
  WHERE worker_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS daily_cash_uq_admin
  ON public.daily_cash (cash_date, admin_id)
  WHERE worker_id IS NULL AND admin_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS daily_cash_uq_global
  ON public.daily_cash (cash_date)
  WHERE worker_id IS NULL AND admin_id IS NULL;
