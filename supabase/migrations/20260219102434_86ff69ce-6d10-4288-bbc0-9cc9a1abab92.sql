-- Add is_cravo flag to loans for marking slow-paying clients
ALTER TABLE public.loans ADD COLUMN is_cravo boolean NOT NULL DEFAULT false;