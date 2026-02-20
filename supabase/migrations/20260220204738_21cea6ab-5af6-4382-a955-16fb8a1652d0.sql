
-- Cash movements table to track all financial transactions
CREATE TABLE public.cash_movements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL, -- 'emprestimo', 'recebimento_normal', 'recebimento_multa', 'entrada_manual', 'saida_manual', 'ajuste_manual'
  amount NUMERIC NOT NULL,
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  loan_id UUID REFERENCES public.loans(id) ON DELETE SET NULL,
  installment_id UUID REFERENCES public.installments(id) ON DELETE SET NULL,
  observation TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to cash_movements" ON public.cash_movements FOR ALL USING (true) WITH CHECK (true);

-- Cash balance table (single row) for fast reads
CREATE TABLE public.cash_balance (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  available_cash NUMERIC NOT NULL DEFAULT 0,
  money_lent NUMERIC NOT NULL DEFAULT 0,
  interest_receivable NUMERIC NOT NULL DEFAULT 0,
  penalty_receivable NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.cash_balance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to cash_balance" ON public.cash_balance FOR ALL USING (true) WITH CHECK (true);

-- Insert initial balance row
INSERT INTO public.cash_balance (available_cash, money_lent, interest_receivable, penalty_receivable) VALUES (0, 0, 0, 0);
