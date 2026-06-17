ALTER TABLE public.daily_events ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE public.audit_logs   ADD COLUMN IF NOT EXISTS metadata jsonb;
CREATE INDEX IF NOT EXISTS idx_daily_events_metadata ON public.daily_events USING gin (metadata);
CREATE INDEX IF NOT EXISTS idx_audit_logs_metadata   ON public.audit_logs   USING gin (metadata);