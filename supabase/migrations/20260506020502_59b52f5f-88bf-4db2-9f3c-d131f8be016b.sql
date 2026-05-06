ALTER TABLE public.installments
DROP CONSTRAINT IF EXISTS installments_status_check;

ALTER TABLE public.installments
ADD CONSTRAINT installments_status_check
CHECK (status IN ('pending', 'partial', 'overdue', 'paid'));

UPDATE public.installments
SET status = CASE
  WHEN COALESCE(paid_amount, 0) >= COALESCE(amount, 0) - 0.01 THEN 'paid'
  WHEN COALESCE(paid_amount, 0) > 0 AND COALESCE(paid_amount, 0) < COALESCE(amount, 0) - 0.01 THEN 'partial'
  WHEN COALESCE(paid_amount, 0) = 0 AND due_date < CURRENT_DATE THEN 'overdue'
  ELSE 'pending'
END,
paid_at = CASE
  WHEN COALESCE(paid_amount, 0) > 0 THEN COALESCE(paid_at, now())
  ELSE NULL
END;

ALTER TABLE public.daily_events
ADD COLUMN IF NOT EXISTS cash_movement_id uuid;

ALTER TABLE public.cash_movements
ADD COLUMN IF NOT EXISTS daily_event_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'daily_events_cash_movement_id_fkey'
  ) THEN
    ALTER TABLE public.daily_events
    ADD CONSTRAINT daily_events_cash_movement_id_fkey
    FOREIGN KEY (cash_movement_id) REFERENCES public.cash_movements(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cash_movements_daily_event_id_fkey'
  ) THEN
    ALTER TABLE public.cash_movements
    ADD CONSTRAINT cash_movements_daily_event_id_fkey
    FOREIGN KEY (daily_event_id) REFERENCES public.daily_events(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_daily_events_cash_movement_id
ON public.daily_events (cash_movement_id);

CREATE INDEX IF NOT EXISTS idx_cash_movements_daily_event_id
ON public.cash_movements (daily_event_id);

CREATE INDEX IF NOT EXISTS idx_cash_movements_payment_identity
ON public.cash_movements (id, loan_id, cash_date, type);

CREATE INDEX IF NOT EXISTS idx_daily_events_payment_identity
ON public.daily_events (id, loan_id, cash_date, event_type);