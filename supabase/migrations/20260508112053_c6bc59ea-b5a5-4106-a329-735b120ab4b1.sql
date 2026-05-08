CREATE OR REPLACE FUNCTION public.admin_find_orphans()
RETURNS TABLE(entity_type text, entity_id uuid, label text, missing text, created_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'client'::text, c.id, c.name,
         CASE
           WHEN c.worker_id IS NULL AND c.admin_id IS NULL THEN 'worker_id+admin_id'
           WHEN c.worker_id IS NULL THEN 'worker_id'
           ELSE 'admin_id'
         END,
         c.created_at
    FROM public.clients c
   WHERE (c.worker_id IS NULL OR c.admin_id IS NULL)
     AND (public.is_super_admin(auth.uid())
          OR (public.has_role(auth.uid(),'admin'::app_role) AND c.admin_id = public.get_admin_id(auth.uid())))
  UNION ALL
  SELECT 'loan'::text, l.id, COALESCE((SELECT name FROM public.clients WHERE id = l.client_id), '—'),
         CASE
           WHEN l.worker_id IS NULL AND l.admin_id IS NULL THEN 'worker_id+admin_id'
           WHEN l.worker_id IS NULL THEN 'worker_id'
           ELSE 'admin_id'
         END,
         l.created_at
    FROM public.loans l
   WHERE (l.worker_id IS NULL OR l.admin_id IS NULL)
     AND (public.is_super_admin(auth.uid())
          OR (public.has_role(auth.uid(),'admin'::app_role) AND l.admin_id = public.get_admin_id(auth.uid())))
  ORDER BY created_at DESC
  LIMIT 200;
$$;