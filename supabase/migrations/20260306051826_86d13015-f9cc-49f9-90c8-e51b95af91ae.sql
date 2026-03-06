
CREATE OR REPLACE FUNCTION public.update_cash_balance_atomic(
  p_available_cash numeric DEFAULT 0,
  p_money_lent numeric DEFAULT 0,
  p_interest_receivable numeric DEFAULT 0,
  p_penalty_receivable numeric DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.cash_balance
  SET
    available_cash = available_cash + p_available_cash,
    money_lent = money_lent + p_money_lent,
    interest_receivable = interest_receivable + p_interest_receivable,
    penalty_receivable = penalty_receivable + p_penalty_receivable,
    updated_at = now();
END;
$$;
