CREATE POLICY "Usuario visualiza controle da propria empresa"
ON public.company_access_controls
FOR SELECT
TO authenticated
USING (admin_id = public.get_admin_id(auth.uid()));