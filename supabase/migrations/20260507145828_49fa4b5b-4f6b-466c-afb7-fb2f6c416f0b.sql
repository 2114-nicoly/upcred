
-- 1) Remove hardcoded super_admin email from handle_new_user trigger
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'operador'::app_role)
    ON CONFLICT DO NOTHING;

  RETURN NEW;
END; $function$;

-- 2) Tighten worker_password_reset_requests RLS to admin's own team
DROP POLICY IF EXISTS "Admins manage reset requests" ON public.worker_password_reset_requests;

CREATE POLICY "Admins manage own team reset requests"
ON public.worker_password_reset_requests
FOR ALL
TO authenticated
USING (
  public.is_super_admin(auth.uid())
  OR (
    public.has_role(auth.uid(), 'admin'::app_role)
    AND EXISTS (
      SELECT 1 FROM public.workers w
      WHERE w.login_codigo = worker_password_reset_requests.identifier
        AND w.parent_admin_id = public.get_admin_id(auth.uid())
    )
  )
)
WITH CHECK (
  public.is_super_admin(auth.uid())
  OR (
    public.has_role(auth.uid(), 'admin'::app_role)
    AND EXISTS (
      SELECT 1 FROM public.workers w
      WHERE w.login_codigo = worker_password_reset_requests.identifier
        AND w.parent_admin_id = public.get_admin_id(auth.uid())
    )
  )
);

-- 3) Allow admins to redact / delete worker_credentials_log entries (purge plaintext temp passwords)
CREATE POLICY "Admin update own credentials log"
ON public.worker_credentials_log
FOR UPDATE
TO authenticated
USING (
  public.is_super_admin(auth.uid())
  OR (public.has_role(auth.uid(), 'admin'::app_role)
      AND ((created_by = auth.uid()) OR (admin_id = public.get_admin_id(auth.uid()))))
)
WITH CHECK (
  public.is_super_admin(auth.uid())
  OR (public.has_role(auth.uid(), 'admin'::app_role)
      AND ((created_by = auth.uid()) OR (admin_id = public.get_admin_id(auth.uid()))))
);

CREATE POLICY "Admin delete own credentials log"
ON public.worker_credentials_log
FOR DELETE
TO authenticated
USING (
  public.is_super_admin(auth.uid())
  OR (public.has_role(auth.uid(), 'admin'::app_role)
      AND ((created_by = auth.uid()) OR (admin_id = public.get_admin_id(auth.uid()))))
);

-- 4) Auto-redact plaintext temp_password from credential log entries older than 7 days
CREATE OR REPLACE FUNCTION public.redact_old_credentials_log()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  UPDATE public.worker_credentials_log
     SET temp_password = '__redacted__',
         status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END
   WHERE temp_password <> '__redacted__'
     AND created_at < now() - interval '7 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
