CREATE OR REPLACE FUNCTION public.close_daily_cash_with_snapshot(
  p_cash_date date, p_counted numeric, p_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_worker uuid; v_admin uuid; v_id uuid; v_opening numeric;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());
  IF v_worker IS NOT NULL THEN
    SELECT parent_admin_id INTO v_admin FROM public.workers WHERE id = v_worker;
  END IF;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'usuário sem escopo (empresa) para fechar caixa';
  END IF;

  SELECT id, COALESCE(opening_balance, 0) INTO v_id, v_opening
    FROM public.daily_cash
   WHERE cash_date = p_cash_date
     AND worker_id IS NOT DISTINCT FROM v_worker
     AND admin_id = v_admin
   LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'caixa deste dia ainda não foi aberto';
  END IF;

  PERFORM public._assert_closing_consistency(v_admin, v_worker, p_cash_date, v_opening);

  RETURN public._close_daily_cash_core(v_id, p_counted, p_note, 'manual', auth.uid());
END;
$$;
