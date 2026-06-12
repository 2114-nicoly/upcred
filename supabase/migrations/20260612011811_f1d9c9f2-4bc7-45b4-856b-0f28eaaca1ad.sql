
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS is_imported_ongoing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS amount_already_paid numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS initial_remaining_balance numeric NULL;
