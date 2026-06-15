
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID;

ALTER TABLE public.penalties
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_archived_at ON public.clients(archived_at);
CREATE INDEX IF NOT EXISTS idx_penalties_cancelled_at ON public.penalties(cancelled_at);
