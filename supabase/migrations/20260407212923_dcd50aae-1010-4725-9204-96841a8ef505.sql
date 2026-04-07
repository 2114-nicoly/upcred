
-- Add cash_date column to cash_movements
ALTER TABLE public.cash_movements
ADD COLUMN cash_date date NOT NULL DEFAULT CURRENT_DATE;

-- Backfill existing records: use the date portion of created_at
UPDATE public.cash_movements
SET cash_date = (created_at AT TIME ZONE 'UTC')::date;

-- Create index for efficient queries by cash_date
CREATE INDEX idx_cash_movements_cash_date ON public.cash_movements (cash_date);
