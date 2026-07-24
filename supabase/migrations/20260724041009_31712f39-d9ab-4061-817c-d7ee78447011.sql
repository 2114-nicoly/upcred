
-- Allow multiple snapshots per daily_cash row (one per close/version).
ALTER TABLE public.daily_cash_snapshots
  DROP CONSTRAINT IF EXISTS daily_cash_snapshots_daily_cash_id_key;

ALTER TABLE public.daily_cash_snapshots
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE public.daily_cash_snapshots
  ADD COLUMN IF NOT EXISTS reopen_reason text NULL;

-- Backfill: any existing rows are version 1.
UPDATE public.daily_cash_snapshots SET version = 1 WHERE version IS NULL OR version = 0;

-- Enforce uniqueness of (daily_cash_id, version) so we can safely compute next.
CREATE UNIQUE INDEX IF NOT EXISTS ux_daily_cash_snapshots_dc_version
  ON public.daily_cash_snapshots (daily_cash_id, version);

CREATE INDEX IF NOT EXISTS idx_daily_cash_snapshots_dc_created
  ON public.daily_cash_snapshots (daily_cash_id, created_at DESC);
