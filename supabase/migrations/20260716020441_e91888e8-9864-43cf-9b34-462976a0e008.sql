
-- Add archived_by to workers (nullable) for audit trail
ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS archived_by uuid;

-- Replace archive_worker: super_admin only, optional cascade to clients, atomic
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
  IF NOT public.is_super_admin(v_uid) THEN
    RAISE EXCEPTION 'Apenas Super Administrador pode arquivar trabalhadores';
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

-- Replace unarchive_worker: super_admin only, optional cascade
CREATE OR REPLACE FUNCTION public.unarchive_worker(p_worker_id uuid, p_cascade boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_worker record;
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_clients_unarchived int := 0;
BEGIN
  IF NOT public.is_super_admin(v_uid) THEN
    RAISE EXCEPTION 'Apenas Super Administrador pode desarquivar trabalhadores';
  END IF;

  SELECT * INTO v_worker FROM public.workers WHERE id = p_worker_id;
  IF v_worker.id IS NULL THEN RAISE EXCEPTION 'Trabalhador não encontrado'; END IF;

  UPDATE public.workers
     SET archived_at = NULL, archived_by = NULL, updated_at = v_now
   WHERE id = p_worker_id;

  IF p_cascade THEN
    WITH upd AS (
      UPDATE public.clients
         SET archived_at = NULL, archived_by = NULL
       WHERE worker_id = p_worker_id AND archived_at IS NOT NULL
       RETURNING id
    )
    SELECT count(*) INTO v_clients_unarchived FROM upd;
  END IF;

  PERFORM public.log_audit(
    'desarquivar_trabalhador','worker',p_worker_id,
    NULL,
    jsonb_build_object('cascade', p_cascade, 'clients_unarchived', v_clients_unarchived, 'nome', v_worker.nome),
    NULL, p_worker_id
  );

  RETURN jsonb_build_object('ok', true, 'clients_unarchived', v_clients_unarchived, 'cascade', p_cascade);
END;
$function$;

-- Drop old single-arg signatures so callers hit the new function
DROP FUNCTION IF EXISTS public.archive_worker(uuid);
DROP FUNCTION IF EXISTS public.unarchive_worker(uuid);

-- Bulk archive of clients (super_admin only)
CREATE OR REPLACE FUNCTION public.bulk_archive_clients(p_client_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_now timestamptz := now(); v_count int := 0;
BEGIN
  IF NOT public.is_super_admin(v_uid) THEN
    RAISE EXCEPTION 'Apenas Super Administrador pode arquivar clientes em lote';
  END IF;
  WITH upd AS (
    UPDATE public.clients
       SET archived_at = v_now, archived_by = v_uid
     WHERE id = ANY(p_client_ids) AND archived_at IS NULL
     RETURNING id
  )
  SELECT count(*) INTO v_count FROM upd;
  PERFORM public.log_audit('arquivar_clientes_lote','client',NULL,NULL,
    jsonb_build_object('count', v_count, 'ids', to_jsonb(p_client_ids)),NULL,NULL);
  RETURN jsonb_build_object('ok', true, 'count', v_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.bulk_unarchive_clients(p_client_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_count int := 0;
BEGIN
  IF NOT public.is_super_admin(v_uid) THEN
    RAISE EXCEPTION 'Apenas Super Administrador pode restaurar clientes em lote';
  END IF;
  WITH upd AS (
    UPDATE public.clients
       SET archived_at = NULL, archived_by = NULL
     WHERE id = ANY(p_client_ids) AND archived_at IS NOT NULL
     RETURNING id
  )
  SELECT count(*) INTO v_count FROM upd;
  PERFORM public.log_audit('desarquivar_clientes_lote','client',NULL,NULL,
    jsonb_build_object('count', v_count, 'ids', to_jsonb(p_client_ids)),NULL,NULL);
  RETURN jsonb_build_object('ok', true, 'count', v_count);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.archive_worker(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unarchive_worker(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_archive_clients(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_unarchive_clients(uuid[]) TO authenticated;
