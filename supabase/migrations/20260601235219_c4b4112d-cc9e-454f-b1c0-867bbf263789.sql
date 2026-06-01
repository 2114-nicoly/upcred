
-- Returns NULL if the daily_cash is empty (candidate), else a human-readable reason.
CREATE OR REPLACE FUNCTION public._daily_cash_emptiness_reason(p_cash_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_date date; v_worker uuid; v_admin uuid;
  v_count int;
BEGIN
  SELECT cash_date, worker_id, admin_id
    INTO v_date, v_worker, v_admin
    FROM public.daily_cash WHERE id = p_cash_id;
  IF v_date IS NULL THEN RETURN 'caixa inexistente'; END IF;

  -- Real financial / operational activity in daily_events.
  -- Ignored admin events: caixa_aberto, caixa_fechado, reabrir_caixa, and
  -- ajuste_caixa when both amounts are zero.
  SELECT COUNT(*) INTO v_count
    FROM public.daily_events de
   WHERE de.cash_date = v_date
     AND de.worker_id IS NOT DISTINCT FROM v_worker
     AND (de.admin_id IS NULL OR v_admin IS NULL OR de.admin_id = v_admin)
     AND de.reversed_at IS NULL
     AND NOT (
       de.event_type IN ('caixa_aberto','caixa_fechado','reabrir_caixa')
       OR (de.event_type = 'ajuste_caixa'
           AND COALESCE(de.amount_in,0) = 0
           AND COALESCE(de.amount_out,0) = 0)
     );
  IF v_count > 0 THEN RETURN v_count || ' evento(s) financeiros/operacionais'; END IF;

  -- cash_movements not reversed
  SELECT COUNT(*) INTO v_count
    FROM public.cash_movements cm
   WHERE cm.cash_date = v_date
     AND cm.worker_id IS NOT DISTINCT FROM v_worker
     AND (cm.admin_id IS NULL OR v_admin IS NULL OR cm.admin_id = v_admin)
     AND cm.reversed_at IS NULL;
  IF v_count > 0 THEN RETURN v_count || ' movimentação(ões) de caixa'; END IF;

  -- not_paid_marks
  SELECT COUNT(*) INTO v_count
    FROM public.not_paid_marks nm
   WHERE nm.mark_date = v_date
     AND nm.worker_id IS NOT DISTINCT FROM v_worker
     AND (nm.admin_id IS NULL OR v_admin IS NULL OR nm.admin_id = v_admin);
  IF v_count > 0 THEN RETURN v_count || ' marcação(ões) Não Pagou'; END IF;

  -- loans on this day
  SELECT COUNT(*) INTO v_count
    FROM public.loans l
   WHERE l.loan_date = v_date
     AND l.worker_id IS NOT DISTINCT FROM v_worker
     AND (l.admin_id IS NULL OR v_admin IS NULL OR l.admin_id = v_admin);
  IF v_count > 0 THEN RETURN v_count || ' empréstimo(s) criado(s)'; END IF;

  RETURN NULL;
END;
$$;

-- Keep is_empty wrapper for back-compat
CREATE OR REPLACE FUNCTION public._daily_cash_is_empty(p_cash_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._daily_cash_emptiness_reason(p_cash_id) IS NULL;
$$;

-- List ALL open daily_cash in period (with empty flag + reason for debugging)
DROP FUNCTION IF EXISTS public.admin_find_empty_daily_cash(date,date,uuid,uuid);
CREATE OR REPLACE FUNCTION public.admin_find_empty_daily_cash(
  p_start date,
  p_end date,
  p_admin_id uuid DEFAULT NULL,
  p_worker_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  cash_date date,
  worker_id uuid,
  admin_id uuid,
  worker_nome text,
  admin_nome text,
  opened_at timestamptz,
  is_empty boolean,
  reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super boolean := public.is_super_admin(auth.uid());
  v_my_admin uuid := public.get_admin_id(auth.uid());
BEGIN
  IF NOT (v_is_super OR public.has_role(auth.uid(),'admin'::app_role)) THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  RETURN QUERY
  SELECT dc.id, dc.cash_date, dc.worker_id, dc.admin_id,
         w.nome AS worker_nome,
         a.nome AS admin_nome,
         dc.opened_at,
         (public._daily_cash_emptiness_reason(dc.id) IS NULL) AS is_empty,
         public._daily_cash_emptiness_reason(dc.id) AS reason
    FROM public.daily_cash dc
    LEFT JOIN public.workers w ON w.id = dc.worker_id
    LEFT JOIN public.admins  a ON a.id = dc.admin_id
   WHERE dc.status = 'open'
     AND dc.cash_date BETWEEN p_start AND p_end
     AND (p_worker_id IS NULL OR dc.worker_id = p_worker_id)
     AND (
       (v_is_super AND (
          p_admin_id IS NULL
          OR dc.admin_id = p_admin_id
          OR (dc.admin_id IS NULL AND w.parent_admin_id = p_admin_id)
       ))
       OR (NOT v_is_super AND (
          dc.admin_id = v_my_admin
          OR (dc.admin_id IS NULL AND w.parent_admin_id = v_my_admin)
       ))
     )
   ORDER BY dc.cash_date DESC, w.nome NULLS FIRST;
END;
$$;

-- Cleanup uses same rule and only acts on truly empty rows
CREATE OR REPLACE FUNCTION public.admin_cleanup_empty_daily_cash(
  p_start date,
  p_end date,
  p_admin_id uuid DEFAULT NULL,
  p_worker_id uuid DEFAULT NULL
)
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
BEGIN
  IF NOT (v_is_super OR public.has_role(auth.uid(),'admin'::app_role)) THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'período inválido';
  END IF;

  FOR r IN
    SELECT dc.id, dc.cash_date, dc.worker_id, dc.admin_id, dc.status AS old_status
      FROM public.daily_cash dc
      LEFT JOIN public.workers w ON w.id = dc.worker_id
     WHERE dc.status = 'open'
       AND dc.cash_date BETWEEN p_start AND p_end
       AND (p_worker_id IS NULL OR dc.worker_id = p_worker_id)
       AND (
         (v_is_super AND (
            p_admin_id IS NULL
            OR dc.admin_id = p_admin_id
            OR (dc.admin_id IS NULL AND w.parent_admin_id = p_admin_id)
         ))
         OR (NOT v_is_super AND (
            dc.admin_id = v_my_admin
            OR (dc.admin_id IS NULL AND w.parent_admin_id = v_my_admin)
         ))
       )
       AND public._daily_cash_emptiness_reason(dc.id) IS NULL
  LOOP
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

GRANT EXECUTE ON FUNCTION public._daily_cash_emptiness_reason(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._daily_cash_is_empty(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_find_empty_daily_cash(date,date,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cleanup_empty_daily_cash(date,date,uuid,uuid) TO authenticated;
