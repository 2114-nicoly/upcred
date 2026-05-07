
-- Listar workers de um admin específico (super_admin) ou os próprios (admin)
CREATE OR REPLACE FUNCTION public.list_workers_by_admin(p_admin_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid, nome text, login_codigo text, active boolean, parent_admin_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.id, w.nome, w.login_codigo, w.active, w.parent_admin_id
  FROM public.workers w
  WHERE
    (public.is_super_admin(auth.uid())
       AND (p_admin_id IS NULL OR w.parent_admin_id = p_admin_id))
    OR (public.has_role(auth.uid(),'admin'::app_role)
       AND w.parent_admin_id = public.get_admin_id(auth.uid()))
  ORDER BY w.active DESC, w.nome ASC;
$$;

-- Ativar/desativar admin (apenas super_admin)
CREATE OR REPLACE FUNCTION public.super_admin_set_admin_active(p_admin_id uuid, p_active boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;
  UPDATE public.admins SET active = p_active, updated_at = now() WHERE id = p_admin_id;
END; $$;

-- Atualizar dados do admin (nome, notas) — super_admin
CREATE OR REPLACE FUNCTION public.super_admin_update_admin(p_admin_id uuid, p_nome text, p_notas text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;
  UPDATE public.admins
     SET nome = COALESCE(p_nome, nome),
         notas = p_notas,
         updated_at = now()
   WHERE id = p_admin_id;
END; $$;

-- Ativar/desativar trabalhador (super_admin OU admin do mesmo time)
CREATE OR REPLACE FUNCTION public.set_worker_active(p_worker_id uuid, p_active boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  SELECT parent_admin_id INTO v_parent FROM public.workers WHERE id = p_worker_id;
  IF NOT (public.is_super_admin(auth.uid())
          OR (public.has_role(auth.uid(),'admin'::app_role) AND v_parent = public.get_admin_id(auth.uid()))) THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;
  UPDATE public.workers SET active = p_active, updated_at = now() WHERE id = p_worker_id;
END; $$;

-- Stats por admin (super_admin) — KPIs essenciais para ranking
CREATE OR REPLACE FUNCTION public.super_admin_stats_by_admin(p_start date, p_end date)
RETURNS TABLE(
  admin_id uuid,
  admin_nome text,
  active boolean,
  workers_count integer,
  active_loans integer,
  total_received numeric,
  total_lent numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    a.id AS admin_id,
    a.nome AS admin_nome,
    a.active,
    (SELECT COUNT(*)::int FROM public.workers w WHERE w.parent_admin_id = a.id AND w.active),
    (SELECT COUNT(*)::int FROM public.loans l WHERE l.admin_id = a.id AND l.status = 'open'),
    COALESCE((SELECT SUM(de.amount_in) FROM public.daily_events de
        WHERE de.admin_id = a.id AND de.cash_date BETWEEN p_start AND p_end), 0),
    COALESCE((SELECT SUM(de.amount_out) FROM public.daily_events de
        WHERE de.admin_id = a.id AND de.cash_date BETWEEN p_start AND p_end
          AND de.event_type IN ('emprestimo','renovacao')), 0)
  FROM public.admins a
  WHERE public.is_super_admin(auth.uid())
  ORDER BY a.active DESC, a.nome ASC;
$$;
