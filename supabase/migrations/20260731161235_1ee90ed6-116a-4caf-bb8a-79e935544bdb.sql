CREATE OR REPLACE FUNCTION public.close_daily_cash_with_snapshot(
  p_cash_date date,
  p_counted numeric,
  p_note text DEFAULT NULL,
  p_payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cash_id uuid;
  v_worker uuid;
  v_admin uuid;
  v_version int;
  v_reopen_reason text := NULL;
  v_payload jsonb;
BEGIN
  IF p_payload IS NULL THEN
    RAISE EXCEPTION 'snapshot obrigatório para fechar o caixa';
  END IF;

  -- Fecha o caixa (mesma lógica oficial). Falha aqui aborta tudo.
  v_cash_id := public.close_daily_cash_v2(p_cash_date, p_counted, p_note);

  SELECT worker_id, admin_id INTO v_worker, v_admin
    FROM public.daily_cash WHERE id = v_cash_id;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM public.daily_cash_snapshots WHERE daily_cash_id = v_cash_id;

  IF v_version > 1 THEN
    SELECT al.new_value->>'reason' INTO v_reopen_reason
      FROM public.audit_logs al
     WHERE al.action_type = 'reabrir_caixa'
       AND (al.new_value->>'cash_date') = p_cash_date::text
     ORDER BY al.created_at DESC
     LIMIT 1;
  END IF;

  v_payload := p_payload || jsonb_build_object('reopen_reason', v_reopen_reason);

  INSERT INTO public.daily_cash_snapshots (
    daily_cash_id, cash_date, worker_id, admin_id,
    closed_at, closed_by, version, reopen_reason, payload
  ) VALUES (
    v_cash_id, p_cash_date, v_worker, v_admin,
    now(), auth.uid(), v_version, v_reopen_reason, v_payload
  );

  RETURN jsonb_build_object('cash_id', v_cash_id, 'version', v_version);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text, jsonb) TO authenticated;