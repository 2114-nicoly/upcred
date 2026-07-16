
CREATE OR REPLACE FUNCTION public.register_expense(
  p_cash_date date,
  p_amount numeric,
  p_category text,
  p_description text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid;
  v_admin  uuid;
  v_movement_id uuid;
  v_event_id uuid;
  v_before numeric := 0;
  v_after  numeric := 0;
  v_audit_ok boolean := true;
  v_audit_err text := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'valor da despesa deve ser maior que zero';
  END IF;
  IF p_category IS NULL OR length(btrim(p_category)) = 0 THEN
    RAISE EXCEPTION 'categoria da despesa é obrigatória';
  END IF;
  IF p_description IS NULL OR length(btrim(p_description)) < 3 THEN
    RAISE EXCEPTION 'descrição da despesa é obrigatória (mín. 3 caracteres)';
  END IF;
  IF p_cash_date IS NULL THEN
    p_cash_date := CURRENT_DATE;
  END IF;

  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

  -- Ensure the daily cash for this scope/date is open (not closed, not missing).
  IF public.is_cash_closed(p_cash_date) THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar a despesa.', p_cash_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.daily_cash dc
     WHERE dc.cash_date = p_cash_date
       AND dc.status = 'open'
       AND ((v_worker IS NOT NULL AND dc.worker_id = v_worker)
            OR (v_worker IS NULL AND dc.worker_id IS NULL AND dc.admin_id = v_admin))
  ) THEN
    RAISE EXCEPTION 'Caixa do dia (%) ainda não foi aberto. Abra o caixa antes de registrar a despesa.', p_cash_date
      USING ERRCODE = 'check_violation';
  END IF;

  -- Snapshot balance BEFORE change (scoped row)
  SELECT COALESCE(available_cash, 0) INTO v_before
    FROM public.cash_balance
   WHERE (v_worker IS NOT NULL AND worker_id = v_worker)
      OR (v_worker IS NULL AND worker_id IS NULL AND admin_id = v_admin)
   LIMIT 1;
  v_before := COALESCE(v_before, 0);

  -- 1) cash_movement (expense = negative amount)
  INSERT INTO public.cash_movements (
    type, amount, observation, cash_date, user_id
  ) VALUES (
    'despesa', -p_amount, '[' || p_category || '] ' || p_description, p_cash_date, auth.uid()
  ) RETURNING id INTO v_movement_id;

  -- 2) daily_event linked to the movement
  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation, origin,
    user_id, cash_movement_id, metadata
  ) VALUES (
    p_cash_date, 'despesa', 0, p_amount,
    '[' || p_category || '] ' || p_description, 'geral',
    auth.uid(), v_movement_id,
    jsonb_build_object('category', p_category, 'description', p_description)
  ) RETURNING id INTO v_event_id;

  -- 3) bidirectional link
  UPDATE public.cash_movements SET daily_event_id = v_event_id WHERE id = v_movement_id;

  -- 4) update available_cash for scope (create row if missing)
  PERFORM public.update_cash_balance_atomic(-p_amount, 0, 0, 0);
  v_after := v_before - p_amount;

  -- 5) audit — never rollback the expense if audit alone fails
  BEGIN
    PERFORM public.log_audit(
      'despesa', 'cash', v_event_id,
      NULL,
      jsonb_build_object(
        'amount', p_amount,
        'category', p_category,
        'description', p_description,
        'cash_date', p_cash_date,
        'movement_id', v_movement_id,
        'daily_event_id', v_event_id,
        'cash_before', v_before,
        'cash_after', v_after
      ),
      p_description,
      v_worker
    );
  EXCEPTION WHEN OTHERS THEN
    v_audit_ok := false;
    v_audit_err := SQLERRM;
  END;

  RETURN jsonb_build_object(
    'movement_id', v_movement_id,
    'daily_event_id', v_event_id,
    'cash_before', v_before,
    'cash_after', v_after,
    'audit_ok', v_audit_ok,
    'audit_error', v_audit_err
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_expense(date, numeric, text, text) TO authenticated;

-- Optional attachment metadata updater: link a receipt to an existing expense event
CREATE OR REPLACE FUNCTION public.attach_expense_receipt(
  p_daily_event_id uuid,
  p_receipt jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid;
  v_admin  uuid;
  v_ev_worker uuid;
  v_ev_admin  uuid;
  v_ev_type   text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT worker_id, admin_id, event_type
    INTO v_ev_worker, v_ev_admin, v_ev_type
    FROM public.daily_events WHERE id = p_daily_event_id;
  IF v_ev_type IS NULL THEN RAISE EXCEPTION 'evento não encontrado'; END IF;
  IF v_ev_type <> 'despesa' THEN RAISE EXCEPTION 'evento não é despesa'; END IF;

  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());
  IF NOT (public.is_super_admin(auth.uid())
          OR (public.has_role(auth.uid(),'admin'::app_role) AND v_ev_admin = v_admin)
          OR (v_ev_worker IS NOT NULL AND v_ev_worker = v_worker)) THEN
    RAISE EXCEPTION 'acesso negado';
  END IF;

  UPDATE public.daily_events
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('receipt', p_receipt)
   WHERE id = p_daily_event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attach_expense_receipt(uuid, jsonb) TO authenticated;
