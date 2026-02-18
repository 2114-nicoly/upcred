
CREATE TABLE public.penalties (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  loan_id UUID NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
  installment_id UUID NOT NULL REFERENCES public.installments(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.penalties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to penalties"
ON public.penalties
FOR ALL
USING (true)
WITH CHECK (true);
