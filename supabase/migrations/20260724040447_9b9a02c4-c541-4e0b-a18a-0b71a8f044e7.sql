
-- Snapshot table: freezes the exact state of a Rota do Dia / Caixa do Dia
-- at the moment the daily_cash was closed. When a day is closed the app
-- reads the snapshot instead of live data, so subsequent changes to
-- loans, installments, payments, etc. never mutate a closed-day view.

CREATE TABLE IF NOT EXISTS public.daily_cash_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_cash_id uuid NOT NULL UNIQUE REFERENCES public.daily_cash(id) ON DELETE CASCADE,
  cash_date date NOT NULL,
  worker_id uuid NULL,
  admin_id uuid NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_cash_snapshots_scope
  ON public.daily_cash_snapshots (cash_date, worker_id, admin_id);

GRANT SELECT, INSERT, UPDATE ON public.daily_cash_snapshots TO authenticated;
GRANT ALL ON public.daily_cash_snapshots TO service_role;

ALTER TABLE public.daily_cash_snapshots ENABLE ROW LEVEL SECURITY;

-- Read: super_admin sees all; admin sees own scope; worker sees own scope.
CREATE POLICY "snapshot_select_scoped"
  ON public.daily_cash_snapshots FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR (worker_id IS NOT NULL AND worker_id = public.get_worker_id(auth.uid()))
  );

-- Insert: same scope rules; the app writes the snapshot right after closing.
CREATE POLICY "snapshot_insert_scoped"
  ON public.daily_cash_snapshots FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR (worker_id IS NOT NULL AND worker_id = public.get_worker_id(auth.uid()))
  );

-- Update: only admins/super_admin (used on re-close after reopen).
CREATE POLICY "snapshot_update_scoped"
  ON public.daily_cash_snapshots FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR (worker_id IS NOT NULL AND worker_id = public.get_worker_id(auth.uid()))
  )
  WITH CHECK (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(),'admin'::app_role) AND admin_id = public.get_admin_id(auth.uid()))
    OR (worker_id IS NOT NULL AND worker_id = public.get_worker_id(auth.uid()))
  );

CREATE TRIGGER trg_daily_cash_snapshots_updated_at
  BEFORE UPDATE ON public.daily_cash_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
