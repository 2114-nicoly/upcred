
DELETE FROM public.not_paid_marks a
USING public.not_paid_marks b
WHERE a.mark_date = b.mark_date
  AND a.installment_id = b.installment_id
  AND a.created_at > b.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS not_paid_marks_uq_date_installment
  ON public.not_paid_marks (mark_date, installment_id);
