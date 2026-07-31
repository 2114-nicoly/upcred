ALTER TABLE public.company_access_controls REPLICA IDENTITY FULL;
ALTER TABLE public.access_control_settings REPLICA IDENTITY FULL;
ALTER TABLE public.worker_access_licenses REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.company_access_controls;
ALTER PUBLICATION supabase_realtime ADD TABLE public.access_control_settings;
ALTER PUBLICATION supabase_realtime ADD TABLE public.worker_access_licenses;