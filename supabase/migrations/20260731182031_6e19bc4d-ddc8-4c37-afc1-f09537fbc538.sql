-- Helper: fractional installment progress formatting ("7,5/24")
CREATE OR REPLACE FUNCTION public._fmt_inst_fraction(p_paid numeric, p_inst_amount numeric)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $$
DECLARE v_frac numeric; v_rounded numeric;
BEGIN
  IF p_inst_amount IS NULL OR p_inst_amount <= 0 THEN RETURN '0'; END IF;
  v_frac := p_paid / p_inst_amount;
  v_rounded := floor(v_frac * 10) / 10.0;
  IF abs(v_rounded - round(v_rounded)) < 0.05 THEN
    RETURN trim(to_char(round(v_rounded), 'FM999999999'));
  END IF;
  RETURN replace(trim(to_char(v_rounded, 'FM999999990.0')), '.', ',');
END $$;

CREATE OR REPLACE FUNCTION public._fmt_progress(p_paid numeric, p_inst_amount numeric, p_count integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$ SELECT public._fmt_inst_fraction(p_paid, p_inst_amount) || '/' || COALESCE(p_count, 0)::text $$;

-- Transactional payment registration: loan + installments + cash + ledger + frozen metadata
CREATE OR REPLACE FUNCTION public.register_payment_tx(
  p_loan_id uuid,
  p_amount numeric,
  p_client_id uuid,
  p_cash_date date,
  p_origin text DEFAULT 'rota',
  p_installment_id uuid DEFAULT NULL,
  p_observation text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_loan            public.loans%ROWTYPE;
  v_client_name     text;
  v_worker_id       uuid;
  v_admin_id        uuid;
  v_worker_name     text;
  v_applied         numeric;
  v_balance_before  numeric;
  v_balance_after   numeric;
  v_inst_amount     numeric;
  v_count           integer;
  v_paid_before     numeric;
  v_paid_after      numeric;
  v_paid_base       numeric;
  v_total_paid      numeric;
  v_remaining       numeric;
  v_paid_at         timestamptz;
  v_today           date := CURRENT_DATE;
  v_before          jsonb := '[]'::jsonb;
  v_affected        jsonb := '[]'::jsonb;
  v_movement_id     uuid;
  v_event_id        uuid;
  v_metadata        jsonb;
  v_loan_interest   numeric;
  v_interest_rem    numeric;
  v_to_interest     numeric;
  v_to_principal    numeric;
  r                 record;
  v_new_paid        numeric;
  v_new_status      text;
  v_prev            jsonb;
BEGIN
  IF p_loan_id IS NULL THEN RAISE EXCEPTION 'Empréstimo não informado.'; END IF;
  IF p_cash_date IS NULL THEN RAISE EXCEPTION 'Data do caixa não informada.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'O valor do pagamento deve ser maior que zero.'; END IF;

  SELECT * INTO v_loan FROM public.loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo não encontrado'; END IF;

  -- Scope validation: super admin, admin of the company, worker owner, or creator
  IF NOT (
    public.is_super_admin(auth.uid())
    OR (public.has_role(auth.uid(), 'admin'::app_role) AND v_loan.admin_id = public.get_admin_id(auth.uid()))
    OR v_loan.worker_id = public.get_worker_id(auth.uid())
    OR v_loan.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  IF v_loan.status NOT IN ('open', 'overdue') OR COALESCE(v_loan.remaining_balance, 0) <= 0.01 THEN
    RAISE EXCEPTION 'Empréstimo inativo não pode receber pagamento.';
  END IF;

  IF p_client_id IS NOT NULL AND v_loan.client_id <> p_client_id THEN
    RAISE EXCEPTION 'Cliente informado não pertence a este empréstimo.';
  END IF;

  IF p_installment_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.installments WHERE id = p_installment_id AND loan_id = p_loan_id) THEN
    RAISE EXCEPTION 'Parcela informada não pertence a este empréstimo.';
  END IF;

  v_worker_id := v_loan.worker_id;
  v_admin_id  := COALESCE(v_loan.admin_id, public.get_admin_id(auth.uid()));
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Não foi possível determinar o administrador responsável por esta operação.';
  END IF;

  SELECT name INTO v_client_name FROM public.clients WHERE id = v_loan.client_id;
  IF v_worker_id IS NOT NULL THEN
    SELECT nome INTO v_worker_name FROM public.workers WHERE id = v_worker_id;
  END IF;

  v_balance_before := COALESCE(v_loan.remaining_balance, 0);
  v_applied := LEAST(p_amount, v_balance_before);
  IF v_applied <= 0.01 THEN
    RAISE EXCEPTION 'Não há saldo pendente para este pagamento.';
  END IF;
  v_balance_after := GREATEST(0, v_balance_before - v_applied);

  v_count := COALESCE(v_loan.installment_count, 0);
  v_inst_amount := CASE WHEN v_count > 0 THEN COALESCE(v_loan.total_amount, 0) / v_count ELSE 0 END;
  v_paid_before := GREATEST(0, LEAST(COALESCE(v_loan.total_amount,0), COALESCE(v_loan.total_amount,0) - v_balance_before));
  v_paid_after  := GREATEST(0, LEAST(COALESCE(v_loan.total_amount,0), COALESCE(v_loan.total_amount,0) - v_balance_after));

  -- Capture installment state BEFORE
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'installment_id', i.id, 'number', i.number, 'amount', i.amount,
      'paid_amount', COALESCE(i.paid_amount,0), 'status', i.status
    ) ORDER BY i.number), '[]'::jsonb)
  INTO v_before
  FROM public.installments i
  WHERE i.loan_id = p_loan_id AND i.is_penalty = false;

  -- Apply payment to the loan
  UPDATE public.loans
  SET remaining_balance = v_balance_after,
      status = CASE WHEN v_balance_after <= 0.01 THEN 'paid' ELSE status END
  WHERE id = p_loan_id;

  -- Redistribute installments from remaining_balance (single source of truth)
  v_paid_base := CASE
    WHEN v_loan.is_imported_ongoing THEN
      COALESCE(v_loan.initial_remaining_balance,
               GREATEST(0, COALESCE(v_loan.total_amount,0) - COALESCE(v_loan.amount_already_paid,0)))
    ELSE COALESCE(v_loan.total_amount, 0)
  END;
  v_total_paid := GREATEST(0, v_paid_base - v_balance_after);
  v_remaining := v_total_paid;
  v_paid_at := (p_cash_date::text || 'T12:00:00')::timestamp AT TIME ZONE 'UTC';

  FOR r IN
    SELECT * FROM public.installments
    WHERE loan_id = p_loan_id AND is_penalty = false
    ORDER BY number
    FOR UPDATE
  LOOP
    IF r.status IN ('cancelled', 'renegotiated') THEN CONTINUE; END IF;

    IF v_remaining >= r.amount - 0.01 THEN
      v_new_paid := r.amount;
      v_new_status := 'paid';
      UPDATE public.installments
      SET paid_amount = v_new_paid, status = v_new_status, paid_at = COALESCE(r.paid_at, v_paid_at)
      WHERE id = r.id;
      v_remaining := v_remaining - r.amount;
    ELSIF v_remaining > 0.01 THEN
      v_new_paid := v_remaining;
      v_new_status := 'partial';
      UPDATE public.installments
      SET paid_amount = v_new_paid, status = v_new_status, paid_at = v_paid_at
      WHERE id = r.id;
      v_remaining := 0;
    ELSE
      v_new_paid := 0;
      v_new_status := CASE WHEN r.due_date < v_today THEN 'overdue' ELSE 'pending' END;
      UPDATE public.installments
      SET paid_amount = 0, status = v_new_status, paid_at = NULL
      WHERE id = r.id;
    END IF;

    SELECT e INTO v_prev FROM jsonb_array_elements(v_before) e
    WHERE (e->>'installment_id')::uuid = r.id LIMIT 1;

    IF abs(v_new_paid - COALESCE((v_prev->>'paid_amount')::numeric, 0)) >= 0.005
       OR COALESCE(v_prev->>'status','') IS DISTINCT FROM v_new_status THEN
      v_affected := v_affected || jsonb_build_object(
        'installment_id', r.id,
        'number', r.number,
        'amount', r.amount,
        'paid_amount_before', COALESCE((v_prev->>'paid_amount')::numeric, 0),
        'paid_amount_after', v_new_paid,
        'status_before', v_prev->>'status',
        'status_after', v_new_status,
        'amount_applied', round(v_new_paid - COALESCE((v_prev->>'paid_amount')::numeric, 0), 2)
      );
    END IF;
  END LOOP;

  -- Cash movement (cash lock guards run here)
  INSERT INTO public.cash_movements (type, amount, client_id, loan_id, installment_id, observation, cash_date, user_id, worker_id, admin_id)
  VALUES ('recebimento_normal', v_applied, v_loan.client_id, p_loan_id, p_installment_id,
          COALESCE(p_observation, 'Pagamento - ' || COALESCE(v_client_name, '')), p_cash_date,
          auth.uid(), v_worker_id, v_admin_id)
  RETURNING id INTO v_movement_id;

  -- Frozen metadata
  v_metadata := jsonb_build_object(
    'payment_amount', v_applied,
    'cash_date', p_cash_date,
    'recorded_at', now(),
    'admin_id', v_admin_id,
    'worker_id', v_worker_id,
    'worker_name', v_worker_name,
    'client_id', v_loan.client_id,
    'client_name', v_client_name,
    'loan_id', p_loan_id,
    'remaining_balance_before', v_balance_before,
    'remaining_balance_after', v_balance_after,
    'paid_installments_before', floor((v_paid_before + 0.01) / NULLIF(v_inst_amount, 0)),
    'paid_installments_after', floor((v_paid_after + 0.01) / NULLIF(v_inst_amount, 0)),
    'installment_progress_before', public._fmt_progress(v_paid_before, v_inst_amount, v_count),
    'installment_progress_after', public._fmt_progress(v_paid_after, v_inst_amount, v_count),
    'installments_advanced', GREATEST(0,
      COALESCE(floor((v_paid_after + 0.01) / NULLIF(v_inst_amount, 0)), 0)
      - COALESCE(floor((v_paid_before + 0.01) / NULLIF(v_inst_amount, 0)), 0)),
    'total_installments', v_count,
    'installment_amount', v_inst_amount,
    'progress_units_before', CASE WHEN v_inst_amount > 0 THEN v_paid_before / v_inst_amount ELSE 0 END,
    'progress_units_after', CASE WHEN v_inst_amount > 0 THEN v_paid_after / v_inst_amount ELSE 0 END,
    'is_imported_ongoing', COALESCE(v_loan.is_imported_ongoing, false),
    'initial_remaining_balance', v_loan.initial_remaining_balance,
    'amount_already_paid', v_loan.amount_already_paid,
    'affected_installments', v_affected
  );

  -- Daily event WITH the metadata (never a second, failable write)
  INSERT INTO public.daily_events (cash_date, event_type, client_id, loan_id, installment_id,
                                   amount_in, amount_out, observation, origin, cash_movement_id,
                                   metadata, user_id, worker_id, admin_id)
  VALUES (p_cash_date, 'pagamento', v_loan.client_id, p_loan_id, p_installment_id,
          v_applied, 0, COALESCE(p_observation, 'Pagamento - ' || COALESCE(v_client_name, '')),
          COALESCE(p_origin, 'rota'), v_movement_id, v_metadata, auth.uid(), v_worker_id, v_admin_id)
  RETURNING id INTO v_event_id;

  UPDATE public.cash_movements SET daily_event_id = v_event_id WHERE id = v_movement_id;

  -- Cash balance (interest first, then principal)
  v_loan_interest := COALESCE(v_loan.total_amount,0) - COALESCE(v_loan.amount,0);
  v_interest_rem := GREATEST(0, v_loan_interest - v_paid_before);
  v_to_interest := LEAST(v_applied, v_interest_rem);
  v_to_principal := v_applied - v_to_interest;

  INSERT INTO public.cash_balance (worker_id, admin_id, available_cash, money_lent, interest_receivable, penalty_receivable)
  SELECT v_worker_id, v_admin_id, 0, 0, 0, 0
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cash_balance
    WHERE worker_id IS NOT DISTINCT FROM v_worker_id
      AND (v_worker_id IS NOT NULL OR admin_id IS NOT DISTINCT FROM v_admin_id)
  );

  UPDATE public.cash_balance
  SET available_cash = available_cash + v_applied,
      interest_receivable = interest_receivable - v_to_interest,
      money_lent = money_lent - v_to_principal,
      updated_at = now()
  WHERE worker_id IS NOT DISTINCT FROM v_worker_id
    AND (v_worker_id IS NOT NULL OR admin_id IS NOT DISTINCT FROM v_admin_id);

  IF v_metadata IS NULL OR NOT (v_metadata ? 'affected_installments') THEN
    RAISE EXCEPTION 'Não foi possível congelar o histórico deste pagamento.';
  END IF;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'new_balance', v_balance_after,
    'movement_id', v_movement_id,
    'event_id', v_event_id,
    'metadata', v_metadata
  );
END $$;

REVOKE ALL ON FUNCTION public.register_payment_tx(uuid, numeric, uuid, date, text, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.register_payment_tx(uuid, numeric, uuid, date, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_payment_tx(uuid, numeric, uuid, date, text, uuid, text) TO service_role;