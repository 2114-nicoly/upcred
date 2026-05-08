CREATE OR REPLACE FUNCTION public.delete_worker_if_empty(p_worker_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count integer; v_parent uuid; v_archived timestamptz; v_active boolean;
BEGIN
  SELECT parent_admin_id, archived_at, active INTO v_parent, v_archived, v_active
    FROM public.workers WHERE id = p_worker_id;
  IF v_parent IS NULL THEN RAISE EXCEPTION 'trabalhador não encontrado'; END IF;

  -- Permissão: super admin OU admin da mesma equipe
  IF NOT (public.is_super_admin(auth.uid())
          OR (public.has_role(auth.uid(),'admin'::app_role)
              AND v_parent = public.get_admin_id(auth.uid()))) THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;

  IF v_active THEN RAISE EXCEPTION 'desative o trabalhador antes de excluir'; END IF;
  IF v_archived IS NULL THEN RAISE EXCEPTION 'arquive o trabalhador antes de excluir'; END IF;

  SELECT COUNT(*) INTO v_count FROM public.clients WHERE worker_id = p_worker_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'trabalhador possui clientes vinculados (%). Histórico preservado — não pode excluir.', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.loans WHERE worker_id = p_worker_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'trabalhador possui empréstimos vinculados (%). Histórico preservado — não pode excluir.', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.daily_events WHERE worker_id = p_worker_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'trabalhador possui eventos no caixa (%). Histórico preservado — não pode excluir.', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.cash_movements WHERE worker_id = p_worker_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'trabalhador possui movimentações de caixa (%). Histórico preservado — não pode excluir.', v_count; END IF;

  PERFORM public.log_audit('excluir_trabalhador','worker',p_worker_id,NULL,NULL,'exclusão definitiva',p_worker_id);
  DELETE FROM public.cash_balance WHERE worker_id = p_worker_id;
  DELETE FROM public.workers WHERE id = p_worker_id;
END;
$function$;