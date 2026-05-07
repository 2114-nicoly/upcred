
CREATE OR REPLACE FUNCTION public.get_synthetic_email_by_login(p_login text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE(
    (SELECT synthetic_email FROM public.workers WHERE login_codigo = p_login AND active = true LIMIT 1),
    (SELECT email_real FROM public.admins WHERE login_codigo = p_login AND active = true LIMIT 1)
  );
$$;
