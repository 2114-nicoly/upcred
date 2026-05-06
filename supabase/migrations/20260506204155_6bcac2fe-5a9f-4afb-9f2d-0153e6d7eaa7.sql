
DROP POLICY IF EXISTS "Authenticated insert audit logs" ON public.audit_logs;

-- Block direct inserts; only the SECURITY DEFINER log_audit function can write
CREATE POLICY "Block direct insert on audit_logs"
  ON public.audit_logs FOR INSERT
  TO authenticated
  WITH CHECK (false);
