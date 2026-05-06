
-- ============================================================
-- 1) APAGAR DADOS OPERACIONAIS (recomeçar do zero)
-- ============================================================
TRUNCATE TABLE
  public.daily_events,
  public.cash_movements,
  public.not_paid_marks,
  public.penalties,
  public.installments,
  public.loans,
  public.daily_cash,
  public.clients,
  public.routes,
  public.route_requests,
  public.cash_balance
RESTART IDENTITY CASCADE;

-- ============================================================
-- 2) ADICIONAR ROLE "trabalhador" AO ENUM app_role
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'app_role' AND e.enumlabel = 'trabalhador'
  ) THEN
    ALTER TYPE public.app_role ADD VALUE 'trabalhador';
  END IF;
END$$;

-- ============================================================
-- 3) TABELA workers
-- ============================================================
CREATE TABLE IF NOT EXISTS public.workers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  auth_user_id uuid UNIQUE,
  login_codigo text NOT NULL UNIQUE,
  synthetic_email text NOT NULL UNIQUE,
  nome text NOT NULL,
  notas text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage workers" ON public.workers;
CREATE POLICY "Admins manage workers" ON public.workers
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Workers see self" ON public.workers;
CREATE POLICY "Workers see self" ON public.workers
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

DROP TRIGGER IF EXISTS trg_workers_updated_at ON public.workers;
CREATE TRIGGER trg_workers_updated_at
  BEFORE UPDATE ON public.workers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- 4) TABELA worker_credentials_log (somente admin lê)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.worker_credentials_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  login_codigo text NOT NULL,
  temp_password text NOT NULL,
  reason text NOT NULL DEFAULT 'created',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.worker_credentials_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage credentials log" ON public.worker_credentials_log;
CREATE POLICY "Admins manage credentials log" ON public.worker_credentials_log
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- 5) TABELA worker_password_reset_requests
-- ============================================================
CREATE TABLE IF NOT EXISTS public.worker_password_reset_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  identifier text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.worker_password_reset_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can request reset" ON public.worker_password_reset_requests;
CREATE POLICY "Anyone can request reset" ON public.worker_password_reset_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (status = 'pending' AND length(trim(identifier)) > 0);

DROP POLICY IF EXISTS "Admins manage reset requests" ON public.worker_password_reset_requests;
CREATE POLICY "Admins manage reset requests" ON public.worker_password_reset_requests
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- 6) FUNÇÃO HELPER: get_worker_id_for(uid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_worker_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.workers WHERE auth_user_id = _user_id LIMIT 1;
$$;

-- ============================================================
-- 7) ADICIONAR worker_id NAS TABELAS OPERACIONAIS
-- ============================================================
ALTER TABLE public.clients         ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL;
ALTER TABLE public.loans           ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL;
ALTER TABLE public.cash_movements  ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL;
ALTER TABLE public.daily_events    ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL;
ALTER TABLE public.daily_cash      ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL;
ALTER TABLE public.not_paid_marks  ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL;
ALTER TABLE public.penalties       ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL;
ALTER TABLE public.routes          ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES public.workers(id) ON DELETE SET NULL;

-- cash_balance: passa a ter UMA linha por trabalhador (admin = NULL = caixa global do admin)
ALTER TABLE public.cash_balance    ADD COLUMN IF NOT EXISTS worker_id uuid REFERENCES public.workers(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cash_balance_worker
  ON public.cash_balance ((COALESCE(worker_id::text, 'admin')));

-- Índices para performance de RLS por worker_id
CREATE INDEX IF NOT EXISTS idx_clients_worker         ON public.clients(worker_id);
CREATE INDEX IF NOT EXISTS idx_loans_worker           ON public.loans(worker_id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_worker  ON public.cash_movements(worker_id);
CREATE INDEX IF NOT EXISTS idx_daily_events_worker    ON public.daily_events(worker_id);
CREATE INDEX IF NOT EXISTS idx_daily_cash_worker      ON public.daily_cash(worker_id);
CREATE INDEX IF NOT EXISTS idx_not_paid_marks_worker  ON public.not_paid_marks(worker_id);
CREATE INDEX IF NOT EXISTS idx_penalties_worker       ON public.penalties(worker_id);
CREATE INDEX IF NOT EXISTS idx_routes_worker          ON public.routes(worker_id);

-- ============================================================
-- 8) RLS: Admin vê tudo, trabalhador vê só worker_id próprio
-- ============================================================

-- CLIENTS
DROP POLICY IF EXISTS "Owner or admin access clients" ON public.clients;
DROP POLICY IF EXISTS "Admin or worker access clients" ON public.clients;
CREATE POLICY "Admin or worker access clients" ON public.clients
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

-- LOANS
DROP POLICY IF EXISTS "Owner or admin access loans" ON public.loans;
DROP POLICY IF EXISTS "Admin or worker access loans" ON public.loans;
CREATE POLICY "Admin or worker access loans" ON public.loans
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

-- CASH_MOVEMENTS
DROP POLICY IF EXISTS "Owner or admin access cash_movements" ON public.cash_movements;
DROP POLICY IF EXISTS "Admin or worker access cash_movements" ON public.cash_movements;
CREATE POLICY "Admin or worker access cash_movements" ON public.cash_movements
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

-- DAILY_EVENTS
DROP POLICY IF EXISTS "Owner or admin access daily_events" ON public.daily_events;
DROP POLICY IF EXISTS "Admin or worker access daily_events" ON public.daily_events;
CREATE POLICY "Admin or worker access daily_events" ON public.daily_events
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

-- DAILY_CASH
DROP POLICY IF EXISTS "Owner or admin access daily_cash" ON public.daily_cash;
DROP POLICY IF EXISTS "Admin or worker access daily_cash" ON public.daily_cash;
CREATE POLICY "Admin or worker access daily_cash" ON public.daily_cash
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

-- NOT_PAID_MARKS
DROP POLICY IF EXISTS "Owner or admin access not_paid_marks" ON public.not_paid_marks;
DROP POLICY IF EXISTS "Admin or worker access not_paid_marks" ON public.not_paid_marks;
CREATE POLICY "Admin or worker access not_paid_marks" ON public.not_paid_marks
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

-- PENALTIES
DROP POLICY IF EXISTS "Owner or admin access penalties" ON public.penalties;
DROP POLICY IF EXISTS "Admin or worker access penalties" ON public.penalties;
CREATE POLICY "Admin or worker access penalties" ON public.penalties
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

-- ROUTES
DROP POLICY IF EXISTS "Owner or admin access routes" ON public.routes;
DROP POLICY IF EXISTS "Admin or worker access routes" ON public.routes;
CREATE POLICY "Admin or worker access routes" ON public.routes
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

-- INSTALLMENTS (vinculado via loan)
DROP POLICY IF EXISTS "Access installments via loan" ON public.installments;
CREATE POLICY "Access installments via loan" ON public.installments
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = installments.loan_id
      AND (
        public.has_role(auth.uid(), 'admin')
        OR l.worker_id = public.get_worker_id(auth.uid())
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = installments.loan_id
      AND (
        public.has_role(auth.uid(), 'admin')
        OR l.worker_id = public.get_worker_id(auth.uid())
      )
  ));

-- CASH_BALANCE: trabalhador escreve apenas no próprio
DROP POLICY IF EXISTS "Admins write cash_balance" ON public.cash_balance;
DROP POLICY IF EXISTS "Authenticated read cash_balance" ON public.cash_balance;
DROP POLICY IF EXISTS "Admin or worker write cash_balance" ON public.cash_balance;
DROP POLICY IF EXISTS "Admin or worker read cash_balance" ON public.cash_balance;

CREATE POLICY "Admin or worker read cash_balance" ON public.cash_balance
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

CREATE POLICY "Admin or worker write cash_balance" ON public.cash_balance
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR worker_id = public.get_worker_id(auth.uid())
  );

-- ============================================================
-- 9) Bloquear trabalhador de mudar role/worker_id
-- ============================================================

-- user_roles: trabalhador NÃO pode inserir/atualizar/deletar (já restrito a admin pelo policy "Admins manage roles")
-- workers: trabalhador NÃO pode editar (já restrito acima)

-- Trigger: impedir alteração de worker_id/role indevida em workers
CREATE OR REPLACE FUNCTION public.workers_protect_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    -- trabalhador comum não pode alterar nada via UPDATE
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'apenas admin pode alterar trabalhadores';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workers_protect ON public.workers;
CREATE TRIGGER trg_workers_protect
  BEFORE UPDATE ON public.workers
  FOR EACH ROW EXECUTE FUNCTION public.workers_protect_fields();

-- ============================================================
-- 10) Promover nicknicoly2114@gmail.com a admin (se já existir)
-- ============================================================
DO $$
DECLARE
  v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = 'nicknicoly2114@gmail.com' LIMIT 1;
  IF v_uid IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (v_uid, 'admin')
    ON CONFLICT DO NOTHING;
  END IF;
END$$;

-- ============================================================
-- 11) RPC: criar trabalhador (apenas admin) — gera login/senha
-- A criação do usuário em auth.users é feita pelo client com signUp
-- Esta RPC apenas registra a entrada de workers com login único
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_register_worker(
  p_nome text,
  p_login_codigo text,
  p_synthetic_email text,
  p_auth_user_id uuid,
  p_notas text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_worker_id uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  INSERT INTO public.workers (auth_user_id, login_codigo, synthetic_email, nome, notas, created_by, active)
  VALUES (p_auth_user_id, p_login_codigo, p_synthetic_email, p_nome, p_notas, auth.uid(), true)
  RETURNING id INTO v_worker_id;

  -- Atribuir role 'trabalhador'
  INSERT INTO public.user_roles (user_id, role)
  VALUES (p_auth_user_id, 'trabalhador')
  ON CONFLICT DO NOTHING;

  RETURN v_worker_id;
END;
$$;

-- RPC: buscar email sintético por login_codigo (usado na tela de login)
CREATE OR REPLACE FUNCTION public.get_synthetic_email_by_login(p_login text)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT synthetic_email FROM public.workers
  WHERE login_codigo = p_login AND active = true
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_synthetic_email_by_login(text) TO anon, authenticated;
