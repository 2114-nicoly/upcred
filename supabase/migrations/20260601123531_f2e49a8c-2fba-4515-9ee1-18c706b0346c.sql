
-- Função auxiliar: verifica se daily_cash está realmente vazio
CREATE OR REPLACE FUNCTION public._daily_cash_is_empty(p_cash_id uuid)
RETURNS boolean
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
  IF v_date IS NULL THEN RETURN false; END IF;

  -- daily_events: aceita só caixa_aberto (sem nenhum outro evento)
  SELECT COUNT(*) INTO v_count
    FROM public.daily_events de
   WHERE de.cash_date = v_date
     AND de.worker_id IS NOT DISTINCT FROM v_worker
     AND de.admin_id IS NOT DISTINCT FROM v_admin
     AND de.event_type <> 'caixa_aberto';
  IF v_count > 0 THEN RETURN false; END IF;

  -- cash_movements
  SELECT COUNT(*) INTO v_count
    FROM public.cash_movements cm
   WHERE cm.cash_date = v_date
     AND cm.worker_id IS NOT DISTINCT FROM v_worker
     AND cm.admin_id IS NOT DISTINCT FROM v_admin;
  IF v_count > 0 THEN RETURN false; END IF;

  -- not_paid_marks
  SELECT COUNT(*) INTO v_count
    FROM public.not_paid_marks nm
   WHERE nm.mark_date = v_date
     AND nm.worker_id IS NOT DISTINCT FROM v_worker
     AND nm.admin_id IS NOT DISTINCT FROM v_admin;
  IF v_count > 0 THEN RETURN false; END IF;

  -- loans (loan_date)
  SELECT COUNT(*) INTO v_count
    FROM public.loans l
   WHERE l.loan_date = v_date
     AND l.worker_id IS NOT DISTINCT FROM v_worker
     AND l.admin_id IS NOT DISTINCT FROM v_admin;
  IF v_count > 0 THEN RETURN false; END IF;

  RETURN true;
END;
$$;

-- Preview: lista caixas vazios
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
  opened_at timestamptz
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
         dc.opened_at
    FROM public.daily_cash dc
    LEFT JOIN public.workers w ON w.id = dc.worker_id
    LEFT JOIN public.admins  a ON a.id = dc.admin_id
   WHERE dc.status = 'open'
     AND dc.cash_date BETWEEN p_start AND p_end
     AND (p_worker_id IS NULL OR dc.worker_id = p_worker_id)
     AND (
       v_is_super
         AND (p_admin_id IS NULL OR dc.admin_id = p_admin_id)
       OR
       (NOT v_is_super AND dc.admin_id = v_my_admin)
     )
     AND public._daily_cash_is_empty(dc.id)
   ORDER BY dc.cash_date DESC, w.nome NULLS FIRST;
END;
$$;

-- Execute: remove caixas vazios
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
  v_deleted int := 0;
  r record;
BEGIN
  IF NOT (v_is_super OR public.has_role(auth.uid(),'admin'::app_role)) THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'período inválido';
  END IF;

  FOR r IN
    SELECT dc.id, dc.cash_date, dc.worker_id, dc.admin_id
      FROM public.daily_cash dc
     WHERE dc.status = 'open'
       AND dc.cash_date BETWEEN p_start AND p_end
       AND (p_worker_id IS NULL OR dc.worker_id = p_worker_id)
       AND (
         v_is_super AND (p_admin_id IS NULL OR dc.admin_id = p_admin_id)
         OR (NOT v_is_super AND dc.admin_id = v_my_admin)
       )
       AND public._daily_cash_is_empty(dc.id)
  LOOP
    -- remove evento caixa_aberto associado (se existir)
    DELETE FROM public.daily_events de
     WHERE de.cash_date = r.cash_date
       AND de.worker_id IS NOT DISTINCT FROM r.worker_id
       AND de.admin_id IS NOT DISTINCT FROM r.admin_id
       AND de.event_type = 'caixa_aberto';

    DELETE FROM public.daily_cash WHERE id = r.id;

    PERFORM public.log_audit(
      'ajuste_caixa','cash', r.id, NULL,
      jsonb_build_object('cash_date', r.cash_date, 'worker_id', r.worker_id, 'admin_id', r.admin_id),
      'Caixa vazio removido (limpeza administrativa)', r.worker_id
    );

    v_deleted := v_deleted + 1;
  END LOOP;

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_find_empty_daily_cash(date,date,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cleanup_empty_daily_cash(date,date,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._daily_cash_is_empty(uuid) TO authenticated;
