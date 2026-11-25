DROP POLICY IF EXISTS "auto_close_settings_select" ON public.auto_close_settings;
CREATE POLICY "auto_close_settings_select" ON public.auto_close_settings
FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Autenticados podem ler configuracao de acesso" ON public.access_control_settings;
CREATE POLICY "Usuarios com papel podem ler configuracao de acesso" ON public.access_control_settings
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()));