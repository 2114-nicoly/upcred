ALTER TABLE public.cash_movements
  ADD COLUMN IF NOT EXISTS reverses_movement_id uuid REFERENCES public.cash_movements(id),
  ADD COLUMN IF NOT EXISTS reversal_movement_id uuid REFERENCES public.cash_movements(id),
  ADD COLUMN IF NOT EXISTS reversal_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS cash_movements_reverses_movement_id_uidx
  ON public.cash_movements (reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;

ALTER TABLE public.daily_events
  ADD COLUMN IF NOT EXISTS reverses_event_id uuid REFERENCES public.daily_events(id),
  ADD COLUMN IF NOT EXISTS reversal_event_id uuid REFERENCES public.daily_events(id),
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS daily_events_reverses_event_id_uidx
  ON public.daily_events (reverses_event_id)
  WHERE reverses_event_id IS NOT NULL;