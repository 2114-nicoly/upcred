CREATE INDEX IF NOT EXISTS idx_installments_route_unpaid_due
ON public.installments (due_date, number, loan_id)
WHERE is_penalty = false AND status <> 'paid';

CREATE INDEX IF NOT EXISTS idx_installments_loan_regular_status_due
ON public.installments (loan_id, is_penalty, status, due_date, number);

CREATE INDEX IF NOT EXISTS idx_daily_events_cash_date_type_loan
ON public.daily_events (cash_date, event_type, loan_id);

CREATE INDEX IF NOT EXISTS idx_cash_movements_cash_date_type_loan
ON public.cash_movements (cash_date, type, loan_id);

CREATE INDEX IF NOT EXISTS idx_not_paid_marks_mark_date_loan
ON public.not_paid_marks (mark_date, loan_id, installment_id);

CREATE INDEX IF NOT EXISTS idx_loans_loan_date
ON public.loans (loan_date);

CREATE INDEX IF NOT EXISTS idx_loans_status_loan_date
ON public.loans (status, loan_date DESC);