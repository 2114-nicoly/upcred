ALTER TABLE public.cash_movements
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid;

ALTER TABLE public.daily_events
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_cash_movements_reversed_at ON public.cash_movements(reversed_at);
CREATE INDEX IF NOT EXISTS idx_daily_events_reversed_at ON public.daily_events(reversed_at);