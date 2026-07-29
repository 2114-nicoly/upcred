-- 1. access_control_settings
CREATE TABLE public.access_control_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  enforcement_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT access_control_settings_singleton_key UNIQUE (singleton),
  CONSTRAINT access_control_settings_singleton_true CHECK (singleton = true)
);
GRANT SELECT ON public.access_control_settings TO authenticated;
GRANT ALL ON public.access_control_settings TO service_role;
ALTER TABLE public.access_control_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Autenticados podem ler configuracao de acesso"
  ON public.access_control_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Super admin gerencia configuracao de acesso"
  ON public.access_control_settings FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

INSERT INTO public.access_control_settings (enforcement_enabled) VALUES (false);

-- 2. company_access_controls
CREATE TABLE public.company_access_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL UNIQUE REFERENCES public.admins(id) ON DELETE CASCADE,
  manual_status text NOT NULL DEFAULT 'active',
  pause_reason text,
  paused_at timestamptz,
  paused_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_access_controls_status_chk CHECK (manual_status IN ('active','paused'))
);
GRANT SELECT ON public.company_access_controls TO authenticated;
GRANT ALL ON public.company_access_controls TO service_role;
ALTER TABLE public.company_access_controls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Super admin gerencia controles de empresa"
  ON public.company_access_controls FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));
CREATE POLICY "Admin visualiza controle da propria empresa"
  ON public.company_access_controls FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()));

CREATE TRIGGER company_access_controls_touch
  BEFORE UPDATE ON public.company_access_controls
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. worker_access_licenses
CREATE TABLE public.worker_access_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id uuid NOT NULL UNIQUE REFERENCES public.workers(id) ON DELETE CASCADE,
  admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  monthly_price numeric,
  access_start date,
  access_end date,
  manual_status text NOT NULL DEFAULT 'active',
  pause_reason text,
  paused_at timestamptz,
  paused_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_access_licenses_status_chk CHECK (manual_status IN ('active','paused')),
  CONSTRAINT worker_access_licenses_price_chk CHECK (monthly_price IS NULL OR monthly_price >= 0),
  CONSTRAINT worker_access_licenses_dates_chk CHECK (access_end IS NULL OR access_start IS NULL OR access_end >= access_start)
);
GRANT SELECT ON public.worker_access_licenses TO authenticated;
GRANT ALL ON public.worker_access_licenses TO service_role;
ALTER TABLE public.worker_access_licenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Super admin gerencia licencas"
  ON public.worker_access_licenses FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));
CREATE POLICY "Admin visualiza licencas dos proprios trabalhadores"
  ON public.worker_access_licenses FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()));
CREATE POLICY "Trabalhador visualiza a propria licenca"
  ON public.worker_access_licenses FOR SELECT TO authenticated
  USING (worker_id = public.get_worker_id(auth.uid()));

CREATE TRIGGER worker_access_licenses_touch
  BEFORE UPDATE ON public.worker_access_licenses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- admin_id sempre alinhado ao parent_admin_id do trabalhador
CREATE OR REPLACE FUNCTION public.worker_access_sync_admin_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_parent uuid;
BEGIN
  SELECT parent_admin_id INTO v_parent FROM public.workers WHERE id = NEW.worker_id;
  NEW.admin_id := v_parent;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_access_licenses_sync_admin
  BEFORE INSERT OR UPDATE ON public.worker_access_licenses
  FOR EACH ROW EXECUTE FUNCTION public.worker_access_sync_admin_id();

-- 4. worker_access_periods
CREATE TABLE public.worker_access_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  period_start date,
  period_end date,
  amount_paid numeric,
  paid_at timestamptz,
  months_granted integer,
  payment_method text,
  notes text,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_access_periods_dates_chk CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start),
  CONSTRAINT worker_access_periods_amount_chk CHECK (amount_paid IS NULL OR amount_paid >= 0),
  CONSTRAINT worker_access_periods_months_chk CHECK (months_granted IS NULL OR months_granted > 0)
);
CREATE INDEX worker_access_periods_worker_idx ON public.worker_access_periods (worker_id, created_at DESC);
GRANT SELECT ON public.worker_access_periods TO authenticated;
GRANT ALL ON public.worker_access_periods TO service_role;
ALTER TABLE public.worker_access_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Super admin visualiza periodos"
  ON public.worker_access_periods FOR SELECT TO authenticated
  USING (public.is_super_admin(auth.uid()));
CREATE POLICY "Super admin registra periodos"
  ON public.worker_access_periods FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin(auth.uid()));
CREATE POLICY "Super admin corrige periodos"
  ON public.worker_access_periods FOR UPDATE TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));
CREATE POLICY "Admin visualiza periodos dos proprios trabalhadores"
  ON public.worker_access_periods FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()));
CREATE POLICY "Trabalhador visualiza os proprios periodos"
  ON public.worker_access_periods FOR SELECT TO authenticated
  USING (worker_id = public.get_worker_id(auth.uid()));

CREATE TRIGGER worker_access_periods_sync_admin
  BEFORE INSERT OR UPDATE ON public.worker_access_periods
  FOR EACH ROW EXECUTE FUNCTION public.worker_access_sync_admin_id();