-- 1. Enum de roles
CREATE TYPE public.app_role AS ENUM ('admin', 'operador');

-- 2. Tabela profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 3. Tabela user_roles
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 4. Função SECURITY DEFINER para checar role (evita recursão RLS)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- 5. Trigger: ao criar usuário, cria profile + atribui role
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.app_role;
  v_admin_user_id UUID;
BEGIN
  -- Cria profile
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));

  -- Decide role
  IF NEW.email = 'nicknicoly2114@gmail.com' THEN
    v_role := 'admin';
  ELSE
    v_role := 'operador';
  END IF;
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, v_role);

  -- Se for o admin e os dados existentes não têm dono, atribui tudo a ele
  IF v_role = 'admin' THEN
    UPDATE public.clients SET user_id = NEW.id WHERE user_id IS NULL;
    UPDATE public.loans SET user_id = NEW.id WHERE user_id IS NULL;
    UPDATE public.cash_movements SET user_id = NEW.id WHERE user_id IS NULL;
    UPDATE public.daily_events SET user_id = NEW.id WHERE user_id IS NULL;
    UPDATE public.daily_cash SET user_id = NEW.id WHERE user_id IS NULL;
    UPDATE public.not_paid_marks SET user_id = NEW.id WHERE user_id IS NULL;
    UPDATE public.penalties SET user_id = NEW.id WHERE user_id IS NULL;
    UPDATE public.routes SET user_id = NEW.id WHERE user_id IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 6. Trigger updated_at em profiles
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 7. Adicionar user_id às tabelas de dados (nullable temporariamente para preservar dados)
ALTER TABLE public.clients         ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.loans           ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.cash_movements  ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.daily_events    ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.daily_cash      ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.not_paid_marks  ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.penalties       ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.routes          ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX idx_clients_user_id        ON public.clients(user_id);
CREATE INDEX idx_loans_user_id          ON public.loans(user_id);
CREATE INDEX idx_cash_movements_user_id ON public.cash_movements(user_id);
CREATE INDEX idx_daily_events_user_id   ON public.daily_events(user_id);
CREATE INDEX idx_daily_cash_user_id     ON public.daily_cash(user_id);
CREATE INDEX idx_not_paid_marks_user_id ON public.not_paid_marks(user_id);
CREATE INDEX idx_penalties_user_id      ON public.penalties(user_id);
CREATE INDEX idx_routes_user_id         ON public.routes(user_id);

-- 8. Remover policies antigas permissivas e criar policies por usuário

-- profiles
CREATE POLICY "Users see own profile" ON public.profiles FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- user_roles (apenas admin gerencia; usuário lê o próprio)
CREATE POLICY "Users see own role" ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins manage roles" ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- clients
DROP POLICY IF EXISTS "Allow all access to clients" ON public.clients;
CREATE POLICY "Owner or admin access clients" ON public.clients FOR ALL
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- loans
DROP POLICY IF EXISTS "Allow all access to loans" ON public.loans;
CREATE POLICY "Owner or admin access loans" ON public.loans FOR ALL
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- installments (herda do loan)
DROP POLICY IF EXISTS "Allow all access to installments" ON public.installments;
CREATE POLICY "Access installments via loan" ON public.installments FOR ALL
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = loan_id AND (l.user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.loans l
    WHERE l.id = loan_id AND (l.user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  ));

-- cash_movements
DROP POLICY IF EXISTS "Allow all access to cash_movements" ON public.cash_movements;
CREATE POLICY "Owner or admin access cash_movements" ON public.cash_movements FOR ALL
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- daily_events
DROP POLICY IF EXISTS "Allow all access to daily_events" ON public.daily_events;
CREATE POLICY "Owner or admin access daily_events" ON public.daily_events FOR ALL
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- daily_cash
DROP POLICY IF EXISTS "Allow all access to daily_cash" ON public.daily_cash;
CREATE POLICY "Owner or admin access daily_cash" ON public.daily_cash FOR ALL
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- not_paid_marks
DROP POLICY IF EXISTS "Allow all access to not_paid_marks" ON public.not_paid_marks;
CREATE POLICY "Owner or admin access not_paid_marks" ON public.not_paid_marks FOR ALL
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- penalties
DROP POLICY IF EXISTS "Allow all access to penalties" ON public.penalties;
CREATE POLICY "Owner or admin access penalties" ON public.penalties FOR ALL
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- routes
DROP POLICY IF EXISTS "Allow all access to routes" ON public.routes;
CREATE POLICY "Owner or admin access routes" ON public.routes FOR ALL
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- route_requests (público para criação de pedido)
DROP POLICY IF EXISTS "Allow all access to route_requests" ON public.route_requests;
CREATE POLICY "Anyone can create route_request" ON public.route_requests FOR INSERT
  WITH CHECK (true);
CREATE POLICY "Admins manage route_requests" ON public.route_requests FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- cash_balance (compartilhado: leitura para autenticados, escrita para admin)
DROP POLICY IF EXISTS "Allow all access to cash_balance" ON public.cash_balance;
CREATE POLICY "Authenticated read cash_balance" ON public.cash_balance FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "Admins write cash_balance" ON public.cash_balance FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
