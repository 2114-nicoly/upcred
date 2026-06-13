CREATE OR REPLACE FUNCTION public.get_route_installments(p_cash_date date)
 RETURNS TABLE(id uuid, number integer, amount numeric, due_date date, status text, loan_id uuid, is_penalty boolean, paid_amount numeric, paid_at timestamp with time zone, loan_client_id uuid, loan_amount numeric, loan_total_amount numeric, loan_remaining_balance numeric, loan_installment_count integer, loan_payment_type text, client_id uuid, client_name text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH ranked AS (
    SELECT
      i.id,
      i.number,
      i.amount,
      i.due_date,
      i.status,
      i.loan_id,
      i.is_penalty,
      i.paid_amount,
      i.paid_at,
      l.client_id AS loan_client_id,
      l.amount AS loan_amount,
      l.total_amount AS loan_total_amount,
      l.remaining_balance AS loan_remaining_balance,
      l.installment_count AS loan_installment_count,
      l.payment_type AS loan_payment_type,
      c.id AS client_id,
      c.name AS client_name,
      row_number() OVER (PARTITION BY i.loan_id ORDER BY i.due_date ASC, i.number ASC) AS rn
    FROM public.installments i
    JOIN public.loans l ON l.id = i.loan_id
    JOIN public.clients c ON c.id = l.client_id
    WHERE i.due_date <= p_cash_date
      AND i.status NOT IN ('paid', 'cancelled', 'renegotiated')
      AND i.is_penalty = false
      AND l.status NOT IN ('paid', 'cancelled', 'renegotiated')
      AND COALESCE(l.remaining_balance, 0) > 0.01
      AND (COALESCE(i.amount, 0) - COALESCE(i.paid_amount, 0)) > 0.01
  )
  SELECT
    ranked.id,
    ranked.number,
    ranked.amount,
    ranked.due_date,
    ranked.status,
    ranked.loan_id,
    ranked.is_penalty,
    ranked.paid_amount,
    ranked.paid_at,
    ranked.loan_client_id,
    ranked.loan_amount,
    ranked.loan_total_amount,
    ranked.loan_remaining_balance,
    ranked.loan_installment_count,
    ranked.loan_payment_type,
    ranked.client_id,
    ranked.client_name
  FROM ranked
  WHERE ranked.rn = 1
  ORDER BY ranked.due_date ASC, ranked.number ASC;
$function$;