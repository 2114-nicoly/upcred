
-- 1) Novos campos de auditoria
ALTER TABLE public.daily_cash
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

-- 2) Atualiza cleanup para marcar (não deletar)
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
     WHERE dc.status = 'open'
       AND dc.cash_date BETWEEN p_start AND p_end
       AND (p_worker_id IS NULL OR dc.worker_id = p_worker_id)
       AND (
         v_is_super AND (p_admin_id IS NULL OR dc.admin_id = p_admin_id)
         OR (NOT v_is_super AND dc.admin_id = v_my_admin)
       )
       AND public._daily_cash_is_empty(dc.id)
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

GRANT EXECUTE ON FUNCTION public.admin_cleanup_empty_daily_cash(date,date,uuid,uuid) TO authenticated;
