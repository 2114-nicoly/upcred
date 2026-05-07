-- 1. Coluna archived_at
ALTER TABLE public.workers
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_workers_archived_at ON public.workers(archived_at);

-- 2. Arquivar trabalhador (exige inativo)
CREATE OR REPLACE FUNCTION public.archive_worker(p_worker_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_parent uuid; v_active boolean;
BEGIN
  SELECT parent_admin_id, active INTO v_parent, v_active
    FROM public.workers WHERE id = p_worker_id;
  IF v_parent IS NULL THEN RAISE EXCEPTION 'worker not found'; END IF;

  IF NOT (public.is_super_admin(auth.uid())
          OR (public.has_role(auth.uid(),'admin'::app_role)
              AND v_parent = public.get_admin_id(auth.uid()))) THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;

  IF v_active THEN
    RAISE EXCEPTION 'desative o trabalhador antes de arquivar';
  END IF;

  UPDATE public.workers
     SET archived_at = now(), updated_at = now()
   WHERE id = p_worker_id;

  PERFORM public.log_audit('arquivar_trabalhador','worker',p_worker_id,NULL,NULL,NULL,p_worker_id);
END;
$$;

-- 3. Desarquivar trabalhador
CREATE OR REPLACE FUNCTION public.unarchive_worker(p_worker_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_parent uuid;
BEGIN
  SELECT parent_admin_id INTO v_parent FROM public.workers WHERE id = p_worker_id;
  IF v_parent IS NULL THEN RAISE EXCEPTION 'worker not found'; END IF;

  IF NOT (public.is_super_admin(auth.uid())
          OR (public.has_role(auth.uid(),'admin'::app_role)
              AND v_parent = public.get_admin_id(auth.uid()))) THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;

  UPDATE public.workers
     SET archived_at = NULL, updated_at = now()
   WHERE id = p_worker_id;

  PERFORM public.log_audit('desarquivar_trabalhador','worker',p_worker_id,NULL,NULL,NULL,p_worker_id);
END;
$$;

-- 4. Excluir definitivamente trabalhador (somente sem dados operacionais)
CREATE OR REPLACE FUNCTION public.delete_worker_if_empty(p_worker_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count integer;
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: apenas Super Admin';
  END IF;

  SELECT COUNT(*) INTO v_count FROM public.clients WHERE worker_id = p_worker_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'trabalhador possui clientes vinculados (%).', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.loans WHERE worker_id = p_worker_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'trabalhador possui empréstimos vinculados (%).', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.daily_events WHERE worker_id = p_worker_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'trabalhador possui eventos no caixa (%).', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.cash_movements WHERE worker_id = p_worker_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'trabalhador possui movimentações de caixa (%).', v_count; END IF;

  -- log antes de remover
  PERFORM public.log_audit('excluir_trabalhador','worker',p_worker_id,NULL,NULL,'exclusão definitiva',p_worker_id);

  DELETE FROM public.cash_balance WHERE worker_id = p_worker_id;
  DELETE FROM public.workers WHERE id = p_worker_id;
END;
$$;

-- 5. Listas com filtro de arquivados
CREATE OR REPLACE FUNCTION public.admin_list_workers(p_include_archived boolean DEFAULT false)
RETURNS TABLE(id uuid, nome text, login_codigo text, active boolean, archived_at timestamptz, parent_admin_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT w.id, w.nome, w.login_codigo, w.active, w.archived_at, w.parent_admin_id
  FROM public.workers w
  WHERE (public.is_super_admin(auth.uid())
         OR (public.has_role(auth.uid(),'admin'::app_role) AND w.parent_admin_id = public.get_admin_id(auth.uid())))
    AND (p_include_archived OR w.archived_at IS NULL)
  ORDER BY w.active DESC, w.nome ASC;
$$;

CREATE OR REPLACE FUNCTION public.list_workers_by_admin(
  p_admin_id uuid DEFAULT NULL,
  p_include_archived boolean DEFAULT false
)
RETURNS TABLE(id uuid, nome text, login_codigo text, active boolean, parent_admin_id uuid, archived_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT w.id, w.nome, w.login_codigo, w.active, w.parent_admin_id, w.archived_at
  FROM public.workers w
  WHERE
    ((public.is_super_admin(auth.uid())
       AND (p_admin_id IS NULL OR w.parent_admin_id = p_admin_id))
     OR (public.has_role(auth.uid(),'admin'::app_role)
       AND w.parent_admin_id = public.get_admin_id(auth.uid())))
    AND (p_include_archived OR w.archived_at IS NULL)
  ORDER BY w.active DESC, w.nome ASC;
$$;