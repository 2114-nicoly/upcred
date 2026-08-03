REVOKE ALL ON FUNCTION public.auto_close_enabled_from() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_close_enabled_from() TO authenticated, service_role;
REVOKE ALL ON public.auto_close_settings FROM anon;