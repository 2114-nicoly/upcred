CREATE OR REPLACE FUNCTION public.get_active_daily_cash_for_scope(p_worker_id uuid DEFAULT NULL::uuid, p_admin_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, cash_date date, status text, worker_id uuid, admin_id uuid, opening_balance numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_worker uuid;
  v_admin uuid;
  v_caller_admin uuid;
  v_caller_worker uuid;
  v_is_admin boolean;
  v_is_super boolean;
  v_worker_admin uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'usuário não autenticado'; END IF;

  v_is_super    := public.is_super_admin(auth.uid());
  v_is_admin    := v_is_super OR public.has_role(auth.uid(), 'admin'::app_role);
  v_caller_admin  := public.get_admin_id(auth.uid());
  v_caller_worker := public.get_worker_id(auth.uid());

  IF p_worker_id IS NOT NULL THEN
    SELECT w.parent_admin_id INTO v_worker_admin FROM public.workers w WHERE w.id = p_worker_id;
    IF v_worker_admin IS NULL THEN RAISE EXCEPTION 'trabalhador não encontrado'; END IF;
  END IF;

  IF NOT v_is_admin THEN
    IF v_caller_worker IS NULL THEN RAISE EXCEPTION 'usuário sem escopo (trabalhador)'; END IF;
    IF p_worker_id IS NOT NULL AND p_worker_id IS DISTINCT FROM v_caller_worker THEN
      RAISE EXCEPTION 'caixa fora do seu escopo';
    END IF;
    v_worker := v_caller_worker;
    SELECT w.parent_admin_id INTO v_admin FROM public.workers w WHERE w.id = v_worker;
    IF p_admin_id IS NOT NULL AND p_admin_id IS DISTINCT FROM v_admin THEN
      RAISE EXCEPTION 'caixa fora do seu escopo';
    END IF;
  ELSIF v_is_super THEN
    -- SuperAdmin: sem trabalhador é obrigatório informar a empresa (sem fallback).
    IF p_worker_id IS NULL THEN
      IF p_admin_id IS NULL THEN
        RAISE EXCEPTION 'informe a empresa (admin_id) para consultar o caixa';
      END IF;
      v_worker := NULL;
      v_admin  := p_admin_id;
    ELSE
      IF p_admin_id IS NOT NULL AND v_worker_admin IS DISTINCT FROM p_admin_id THEN
        RAISE EXCEPTION 'trabalhador não pertence à empresa selecionada';
      END IF;
      v_worker := p_worker_id;
      v_admin  := v_worker_admin;
    END IF;
  ELSE
    IF v_caller_admin IS NULL THEN RAISE EXCEPTION 'usuário sem escopo (empresa)'; END IF;
    IF p_admin_id IS NOT NULL AND p_admin_id IS DISTINCT FROM v_caller_admin THEN
      RAISE EXCEPTION 'empresa fora do seu escopo';
    END IF;
    IF p_worker_id IS NOT NULL AND v_worker_admin IS DISTINCT FROM v_caller_admin THEN
      RAISE EXCEPTION 'trabalhador não pertence à sua equipe';
    END IF;
    v_worker := p_worker_id;
    v_admin  := v_caller_admin;
  END IF;

  IF v_admin IS NULL THEN RAISE EXCEPTION 'usuário sem escopo (empresa)'; END IF;

  RETURN QUERY
    SELECT dc.id, dc.cash_date, dc.status, dc.worker_id, dc.admin_id,
           COALESCE(dc.opening_balance, 0)
      FROM public.daily_cash dc
     WHERE dc.status = 'open'
       AND dc.admin_id = v_admin
       AND dc.worker_id IS NOT DISTINCT FROM v_worker
     ORDER BY dc.cash_date ASC
     LIMIT 1;
END $function$;