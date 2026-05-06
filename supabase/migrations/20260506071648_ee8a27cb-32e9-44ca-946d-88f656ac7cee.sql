-- 1) Loan balance RPCs: add ownership check
CREATE OR REPLACE FUNCTION public.apply_loan_payment(p_loan_id uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current numeric;
  v_new numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'payment amount must be greater than zero';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.loans
    WHERE id = p_loan_id
      AND (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  ) THEN
    RAISE EXCEPTION 'access denied';
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
$function$;

CREATE OR REPLACE FUNCTION public.reverse_loan_payment(p_loan_id uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current numeric;
  v_total numeric;
  v_new numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'payment amount must be greater than zero';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.loans
    WHERE id = p_loan_id
      AND (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  ) THEN
    RAISE EXCEPTION 'access denied';
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
$function$;

-- 2) Cash balance RPC: admin-only
CREATE OR REPLACE FUNCTION public.update_cash_balance_atomic(p_available_cash numeric DEFAULT 0, p_money_lent numeric DEFAULT 0, p_interest_receivable numeric DEFAULT 0, p_penalty_receivable numeric DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  UPDATE public.cash_balance
  SET
    available_cash = available_cash + p_available_cash,
    money_lent = money_lent + p_money_lent,
    interest_receivable = interest_receivable + p_interest_receivable,
    penalty_receivable = penalty_receivable + p_penalty_receivable,
    updated_at = now();
END;
$function$;

-- 3) Lock down RPC execution to authenticated users only (revoke from anon)
REVOKE EXECUTE ON FUNCTION public.apply_loan_payment(uuid, numeric) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reverse_loan_payment(uuid, numeric) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_cash_balance_atomic(numeric, numeric, numeric, numeric) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_loan_payment(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_loan_payment(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_cash_balance_atomic(numeric, numeric, numeric, numeric) TO authenticated;

-- 4) Remove hardcoded admin email from handle_new_user trigger
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'operador');

  RETURN NEW;
END;
$function$;

-- 5) Profiles: add INSERT and DELETE policies scoped to owner
CREATE POLICY "Users insert own profile"
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete own profile"
ON public.profiles
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);
