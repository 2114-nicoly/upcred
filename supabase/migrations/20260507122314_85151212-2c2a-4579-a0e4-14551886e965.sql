
-- 1) Add columns
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS temporary_password boolean NOT NULL DEFAULT true;
ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS temporary_password boolean NOT NULL DEFAULT true;

-- 2) Extend worker_credentials_log to be a generic user credentials log
ALTER TABLE public.worker_credentials_log
  ADD COLUMN IF NOT EXISTS role text,
  ADD COLUMN IF NOT EXISTS nome text,
  ADD COLUMN IF NOT EXISTS auth_user_id uuid,
  ADD COLUMN IF NOT EXISTS admin_id uuid,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz;

-- worker_id can now be null for admin entries
ALTER TABLE public.worker_credentials_log ALTER COLUMN worker_id DROP NOT NULL;

-- Replace RLS to support hierarchy
DROP POLICY IF EXISTS "Admins manage credentials log" ON public.worker_credentials_log;

CREATE POLICY "Super admin all credentials log" ON public.worker_credentials_log
  FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

CREATE POLICY "Admin own credentials log" ON public.worker_credentials_log
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(),'admin'::app_role)
    AND (
      created_by = auth.uid()
      OR admin_id = public.get_admin_id(auth.uid())
    )
  );

CREATE POLICY "Admin insert credentials log" ON public.worker_credentials_log
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(),'admin'::app_role)
    OR public.is_super_admin(auth.uid())
  );

-- 3) password_recovery_requests
CREATE TABLE IF NOT EXISTS public.password_recovery_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_informado text,
  nome_informado text,
  email_informado text,
  target_user_id uuid,
  target_role text,
  target_admin_id uuid,
  status text NOT NULL DEFAULT 'open',
  notas text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid
);

ALTER TABLE public.password_recovery_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone create recovery request" ON public.password_recovery_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (status = 'open');

CREATE POLICY "Super admin manage recovery" ON public.password_recovery_requests
  FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

CREATE POLICY "Admin manage own recovery" ON public.password_recovery_requests
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) AND target_admin_id = public.get_admin_id(auth.uid()))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) AND target_admin_id = public.get_admin_id(auth.uid()));

-- 4) Code generators
CREATE OR REPLACE FUNCTION public.generate_admin_login_codigo()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v text; i int := 0;
BEGIN
  LOOP
    v := lpad((floor(random()*90000)+10000)::int::text, 5, '0');
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE login_codigo = v)
       AND NOT EXISTS (SELECT 1 FROM public.workers WHERE login_codigo = v) THEN
      RETURN v;
    END IF;
    i := i+1; IF i > 50 THEN RAISE EXCEPTION 'cannot generate unique admin code'; END IF;
  END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION public.generate_worker_login_codigo()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v text; i int := 0;
BEGIN
  LOOP
    v := lpad((floor(random()*9000)+1000)::int::text, 4, '0');
    IF NOT EXISTS (SELECT 1 FROM public.workers WHERE login_codigo = v)
       AND NOT EXISTS (SELECT 1 FROM public.admins WHERE login_codigo = v) THEN
      RETURN v;
    END IF;
    i := i+1; IF i > 50 THEN RAISE EXCEPTION 'cannot generate unique worker code'; END IF;
  END LOOP;
END; $$;

-- 5) Recovery helpers
CREATE OR REPLACE FUNCTION public.register_recovery_request(
  p_login text, p_nome text, p_email text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_user uuid; v_role text; v_admin uuid;
BEGIN
  -- best-effort lookup
  IF p_login IS NOT NULL AND p_login <> '' THEN
    SELECT auth_user_id, 'admin', id INTO v_user, v_role, v_admin
      FROM public.admins WHERE login_codigo = p_login LIMIT 1;
    IF v_user IS NULL THEN
      SELECT auth_user_id, 'trabalhador', parent_admin_id INTO v_user, v_role, v_admin
        FROM public.workers WHERE login_codigo = p_login LIMIT 1;
    END IF;
  END IF;
  IF v_user IS NULL AND p_email IS NOT NULL AND p_email <> '' THEN
    SELECT auth_user_id, 'admin', id INTO v_user, v_role, v_admin
      FROM public.admins WHERE lower(email_real) = lower(p_email) LIMIT 1;
  END IF;
  INSERT INTO public.password_recovery_requests
    (login_informado, nome_informado, email_informado, target_user_id, target_role, target_admin_id, status)
  VALUES (p_login, p_nome, p_email, v_user, v_role, v_admin, 'open')
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

-- 6) Trigger for super_admin email on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT DO NOTHING;

  IF lower(NEW.email) = 'nicknicoly2114@gmail.com' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'super_admin'::app_role)
      ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'operador'::app_role)
      ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 7) Backfill: if super_admin email already exists in auth.users, ensure role
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'super_admin'::app_role FROM auth.users
WHERE lower(email) = 'nicknicoly2114@gmail.com'
ON CONFLICT DO NOTHING;
