
-- Tabela de clientes
CREATE TABLE public.clients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- Acesso público (sem autenticação)
CREATE POLICY "Allow all access to clients" ON public.clients FOR ALL USING (true) WITH CHECK (true);

-- Tabela de empréstimos
CREATE TABLE public.loans (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  interest_type TEXT NOT NULL CHECK (interest_type IN ('percentage', 'fixed')),
  interest_value NUMERIC NOT NULL,
  total_amount NUMERIC NOT NULL,
  installment_count INTEGER NOT NULL,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('daily', 'weekly', 'biweekly', 'monthly', 'fixed_dates')),
  loan_date DATE NOT NULL DEFAULT CURRENT_DATE,
  first_due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'overdue', 'paid')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.loans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to loans" ON public.loans FOR ALL USING (true) WITH CHECK (true);

-- Tabela de parcelas
CREATE TABLE public.installments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  loan_id UUID NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  amount NUMERIC NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue')),
  paid_at TIMESTAMP WITH TIME ZONE,
  is_penalty BOOLEAN NOT NULL DEFAULT false,
  penalty_amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.installments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to installments" ON public.installments FOR ALL USING (true) WITH CHECK (true);
