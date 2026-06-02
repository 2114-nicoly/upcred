-- New: cancel cleanup by selected IDs only
CREATE OR REPLACE FUNCTION public.admin_cleanup_empty_daily_cash_ids(p_cash_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super boolean := public.is_super_admin(auth.uid());
  v_my_admin uuid := public.get_admin_id(auth.uid());
  v_updated int := 0;
  v_reason text := 'Caixa aberto sem movimentação; retornado ao estado neutro por limpeza administrativa';
  r record;
  v_allowed boolean;
  v_parent_admin uuid;
BEGIN
  IF NOT (v_is_super OR public.has_role(auth.uid(),'admin'::app_role)) THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;
  IF p_cash_ids IS NULL OR array_length(p_cash_ids,1) IS NULL THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT dc.id, dc.cash_date, dc.worker_id, dc.admin_id, dc.status AS old_status
      FROM public.daily_cash dc
     WHERE dc.id = ANY(p_cash_ids)
       AND dc.status = 'open'
  LOOP
    -- scope check
    IF v_is_super THEN
      v_allowed := true;
    ELSE
      IF r.admin_id IS NOT NULL THEN
        v_allowed := (r.admin_id = v_my_admin);
      ELSE
        SELECT parent_admin_id INTO v_parent_admin FROM public.workers WHERE id = r.worker_id;
        v_allowed := (v_parent_admin = v_my_admin);
      END IF;
    END IF;
    IF NOT v_allowed THEN CONTINUE; END IF;

    -- still empty?
    IF public._daily_cash_emptiness_reason(r.id) IS NOT NULL THEN CONTINUE; END IF;

    UPDATE public.daily_cash
       SET status = 'cancelled_empty',
           cancelled_at = now(),
           cancelled_by = auth.uid(),
           cancellation_reason = v_reason
     WHERE id = r.id;

    PERFORM public.log_audit(
      'ajuste_caixa','cash', r.id,
      jsonb_build_object('status', r.old_status),
      jsonb_build_object(
        'status','cancelled_empty',
        'cash_date', r.cash_date,
        'worker_id', r.worker_id,
        'admin_id', r.admin_id,
        'reason', v_reason
      ),
      v_reason, r.worker_id
    );

    v_updated := v_updated + 1;
  END LOOP;

  RETURN v_updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_cleanup_empty_daily_cash_ids(uuid[]) TO authenticated;

-- Fix open_daily_cash: reactivate cancelled_empty/void instead of returning their id as-is
CREATE OR REPLACE FUNCTION public.open_daily_cash(p_cash_date date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid;
  v_admin  uuid;
  v_id uuid;
  v_status text;
  v_opening numeric := 0;
  v_has_open_event boolean;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

  IF v_worker IS NULL AND v_admin IS NULL THEN
    RAISE EXCEPTION 'usuário sem escopo (worker/admin) para abrir caixa';
  END IF;

  IF v_worker IS NOT NULL THEN
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id = v_worker LIMIT 1;
  ELSE
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id = v_admin LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    IF v_status = 'closed' THEN
      RAISE EXCEPTION 'caixa deste dia já foi fechado; reabra antes de operar';
    END IF;

    IF v_status IN ('cancelled_empty','void') THEN
      UPDATE public.daily_cash
         SET status = 'open',
             cancelled_at = NULL,
             cancelled_by = NULL,
             cancellation_reason = NULL,
             opened_at = now(),
             opened_by = auth.uid()
       WHERE id = v_id;

      SELECT EXISTS (
        SELECT 1 FROM public.daily_events de
         WHERE de.cash_date = p_cash_date
           AND de.event_type = 'caixa_aberto'
           AND de.worker_id IS NOT DISTINCT FROM v_worker
           AND de.admin_id IS NOT DISTINCT FROM v_admin
      ) INTO v_has_open_event;

      IF NOT v_has_open_event THEN
        INSERT INTO public.daily_events (
          cash_date, event_type, amount_in, amount_out, observation,
          origin, user_id, worker_id, admin_id
        ) VALUES (
          p_cash_date, 'caixa_aberto', 0, 0, 'Caixa reaberto após cancelamento',
          'caixa', auth.uid(), v_worker, v_admin
        );
      END IF;

      PERFORM public.log_audit('reabrir_caixa','cash',v_id,
        jsonb_build_object('status', v_status),
        jsonb_build_object('status','open','cash_date',p_cash_date,'action','reopen_after_cancel'),
        'Reabertura após cancelamento vazio', v_worker);
    END IF;

    RETURN v_id;
  END IF;

  SELECT COALESCE(counted_closing_balance, expected_closing_balance, 0)
    INTO v_opening
   FROM public.daily_cash
  WHERE cash_date < p_cash_date
    AND status = 'closed'
    AND (CASE WHEN v_worker IS NOT NULL THEN worker_id = v_worker
              ELSE worker_id IS NULL AND admin_id = v_admin END)
  ORDER BY cash_date DESC LIMIT 1;
  v_opening := COALESCE(v_opening, 0);

  INSERT INTO public.daily_cash (
    cash_date, worker_id, admin_id, status,
    opening_balance, opened_at, opened_by, user_id
  ) VALUES (
    p_cash_date, v_worker, v_admin, 'open',
    v_opening, now(), auth.uid(), auth.uid()
  ) RETURNING id INTO v_id;

  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation,
    origin, user_id, worker_id, admin_id
  ) VALUES (
    p_cash_date, 'caixa_aberto', 0, 0, 'Caixa aberto',
    'caixa', auth.uid(), v_worker, v_admin
  );

  PERFORM public.log_audit('reabrir_caixa','cash',v_id,NULL,
    jsonb_build_object('cash_date',p_cash_date,'opening_balance',v_opening,'action','open'),
    'Abertura do caixa', v_worker);
  RETURN v_id;
END;
$$;