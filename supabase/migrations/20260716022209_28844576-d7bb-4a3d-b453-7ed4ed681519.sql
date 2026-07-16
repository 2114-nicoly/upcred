CREATE OR REPLACE FUNCTION public.archive_worker(p_worker_id uuid, p_cascade boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_worker record;
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_clients_archived int := 0;
BEGIN
  IF NOT (public.is_super_admin(v_uid) OR public.has_role(v_uid,'admin'::app_role)) THEN
    RAISE EXCEPTION 'Apenas Administrador ou Super Administrador pode arquivar trabalhadores';
  END IF;

  SELECT * INTO v_worker FROM public.workers WHERE id = p_worker_id;
  IF v_worker.id IS NULL THEN RAISE EXCEPTION 'Trabalhador não encontrado'; END IF;

  IF v_worker.archived_at IS NULL THEN
    UPDATE public.workers
       SET archived_at = v_now, archived_by = v_uid, active = false, updated_at = v_now
     WHERE id = p_worker_id;
  END IF;

  IF p_cascade THEN
    WITH upd AS (
      UPDATE public.clients
         SET archived_at = v_now, archived_by = v_uid
       WHERE worker_id = p_worker_id AND archived_at IS NULL
       RETURNING id
    )
    SELECT count(*) INTO v_clients_archived FROM upd;
  END IF;

  PERFORM public.log_audit(
    'arquivar_trabalhador','worker',p_worker_id,
    NULL,
    jsonb_build_object('cascade', p_cascade, 'clients_archived', v_clients_archived, 'nome', v_worker.nome),
    NULL, p_worker_id
  );

  RETURN jsonb_build_object('ok', true, 'clients_archived', v_clients_archived, 'cascade', p_cascade);
END;
$function$;