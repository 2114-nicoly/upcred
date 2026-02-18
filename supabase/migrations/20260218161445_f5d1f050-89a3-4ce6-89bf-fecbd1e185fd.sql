-- Add paid_amount to track partial payments
ALTER TABLE public.installments ADD COLUMN paid_amount numeric NOT NULL DEFAULT 0;