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
    WHERE i.status NOT IN ('paid', 'cancelled', 'renegotiated')
      AND i.is_penalty = false
      AND l.status NOT IN ('paid', 'cancelled', 'renegotiated')
      AND COALESCE(l.remaining_balance, 0) > 0.01
      AND (COALESCE(i.amount, 0) - COALESCE(i.paid_amount, 0)) > 0.01
      AND (
        CASE WHEN l.payment_type = 'daily'
          THEN EXTRACT(dow FROM p_cash_date) <> 0
          ELSE i.due_date <= p_cash_date
        END
      )
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

DO $mig$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'build_daily_cash_snapshot_v2_legacy';

  v_old := '         AND i2.due_date <= v_date' || chr(10) ||
           '       ORDER BY i2.number ASC LIMIT 1' || chr(10) ||
           '    ) i ON true' || chr(10) ||
           '    WHERE l.status IN (''open'',''overdue'')' || chr(10) ||
           '      AND l.remaining_balance > 0.01';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'trecho de pending_installments não encontrado no snapshot legacy';
  END IF;

  v_new := '         AND (i2.due_date <= v_date OR l.payment_type = ''daily'')' || chr(10) ||
           '       ORDER BY i2.number ASC LIMIT 1' || chr(10) ||
           '    ) i ON true' || chr(10) ||
           '    WHERE l.status IN (''open'',''overdue'')' || chr(10) ||
           '      AND NOT (l.payment_type = ''daily'' AND EXTRACT(dow FROM v_date) = 0)' || chr(10) ||
           '      AND l.remaining_balance > 0.01';

  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END
$mig$;