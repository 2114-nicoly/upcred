ALTER TABLE public.loans
ADD COLUMN IF NOT EXISTS remaining_balance numeric NOT NULL DEFAULT 0;

WITH paid_totals AS (
  SELECT
    loan_id,
    COALESCE(SUM(paid_amount), 0) AS total_paid
  FROM public.installments
  WHERE is_penalty = false
  GROUP BY loan_id
)
UPDATE public.loans l
SET
  remaining_balance = GREATEST(0, COALESCE(l.total_amount, 0) - COALESCE(pt.total_paid, 0)),
  status = CASE
    WHEN GREATEST(0, COALESCE(l.total_amount, 0) - COALESCE(pt.total_paid, 0)) <= 0.01 THEN 'paid'
    ELSE l.status
  END
FROM paid_totals pt
WHERE pt.loan_id = l.id;

UPDATE public.loans l
SET remaining_balance = GREATEST(0, COALESCE(l.total_amount, 0))
WHERE NOT EXISTS (
  SELECT 1
  FROM public.installments i
  WHERE i.loan_id = l.id
    AND i.is_penalty = false
);

CREATE OR REPLACE FUNCTION public.manage_loan_remaining_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  paid_so_far numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.remaining_balance IS NULL OR NEW.remaining_balance = 0 THEN
      NEW.remaining_balance := COALESCE(NEW.total_amount, 0);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
       AND NEW.remaining_balance IS NOT DISTINCT FROM OLD.remaining_balance THEN
      paid_so_far := GREATEST(0, COALESCE(OLD.total_amount, 0) - COALESCE(OLD.remaining_balance, 0));
      NEW.remaining_balance := GREATEST(0, COALESCE(NEW.total_amount, 0) - paid_so_far);
    END IF;
  END IF;

  IF NEW.remaining_balance IS NULL THEN
    NEW.remaining_balance := COALESCE(NEW.total_amount, 0);
  END IF;

  IF NEW.remaining_balance < 0 THEN
    RAISE EXCEPTION 'remaining_balance cannot be negative';
  END IF;

  IF NEW.remaining_balance > COALESCE(NEW.total_amount, 0) THEN
    RAISE EXCEPTION 'remaining_balance cannot exceed total_amount';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manage_loans_remaining_balance ON public.loans;

CREATE TRIGGER manage_loans_remaining_balance
BEFORE INSERT OR UPDATE OF total_amount, remaining_balance
ON public.loans
FOR EACH ROW
EXECUTE FUNCTION public.manage_loan_remaining_balance();

CREATE OR REPLACE FUNCTION public.apply_loan_payment(p_loan_id uuid, p_amount numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current numeric;
  v_new numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'payment amount must be greater than zero';
  END IF;

  SELECT remaining_balance
  INTO v_current
  FROM public.loans
  WHERE id = p_loan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'loan not found';
  END IF;

  v_new := GREATEST(0, v_current - p_amount);

  UPDATE public.loans
  SET remaining_balance = v_new,
      status = CASE
        WHEN v_new <= 0.01 THEN 'paid'
        WHEN status = 'paid' THEN 'open'
        ELSE status
      END
  WHERE id = p_loan_id;

  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_loan_payment(p_loan_id uuid, p_amount numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current numeric;
  v_total numeric;
  v_new numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'payment amount must be greater than zero';
  END IF;

  SELECT remaining_balance, total_amount
  INTO v_current, v_total
  FROM public.loans
  WHERE id = p_loan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'loan not found';
  END IF;

  v_new := LEAST(COALESCE(v_total, 0), v_current + p_amount);

  UPDATE public.loans
  SET remaining_balance = v_new,
      status = CASE
        WHEN v_new <= 0.01 THEN 'paid'
        WHEN status = 'paid' THEN 'open'
        ELSE status
      END
  WHERE id = p_loan_id;

  RETURN v_new;
END;
$$;