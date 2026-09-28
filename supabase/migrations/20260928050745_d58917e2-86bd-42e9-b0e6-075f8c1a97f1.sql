-- Padronização dos registros: metadata completo do pagamento e da renovação (mesma assinatura).
CREATE OR REPLACE FUNCTION public.renew_loan_tx(
  p_old_loan_id uuid,
  p_cash_date date,
  p_paid_amount numeric,
  p_amount numeric,
  p_interest_type text,
  p_interest_value numeric,
  p_total_amount numeric,
  p_installment_count integer,
  p_payment_type text,
  p_first_due_date date,
  p_installments jsonb,
  p_observation text DEFAULT NULL,
  p_payment_observation text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.loans%ROWTYPE;
  v_new public.loans%ROWTYPE;
  v_dc record;
  v_cb_id uuid;
  v_client_name text;
  v_pen numeric := 0;
  v_remaining numeric; v_paid numeric; v_absorbed numeric; v_released numeric;
  v_paid_base numeric; v_int_total numeric; v_paid_before numeric; v_int_rem numeric;
  v_to_int numeric; v_to_pr numeric;
  v_old_before jsonb; v_inst_before jsonb;
  v_inst_count int; v_inst_sum numeric;
  v_paid_at timestamptz;
  v_pay_mov uuid; v_pay_ev uuid; v_abs_ev uuid; v_rel_mov uuid; v_ev uuid;
  v_meta jsonb;
  v_chk record;
  v_reg_total int; v_units_before numeric; v_inst_amt numeric; v_units_after numeric; v_affected jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_old_loan_id IS NULL THEN RAISE EXCEPTION 'Empréstimo a renovar não informado.'; END IF;
  IF p_cash_date IS NULL THEN RAISE EXCEPTION 'Data do caixa não informada.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Informe o valor do novo empréstimo.'; END IF;
  IF p_total_amount IS NULL OR p_total_amount < p_amount THEN RAISE EXCEPTION 'Valor total do novo empréstimo inválido.'; END IF;
  IF p_installment_count IS NULL OR p_installment_count <= 0 THEN RAISE EXCEPTION 'Quantidade de parcelas inválida.'; END IF;
  IF p_installments IS NULL OR jsonb_typeof(p_installments) <> 'array' THEN RAISE EXCEPTION 'Parcelas do novo empréstimo não informadas.'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('renew_loan:' || p_old_loan_id::text, 0));

  SELECT * INTO v_old FROM public.loans WHERE id = p_old_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo não encontrado.'; END IF;
  IF v_old.worker_id IS NULL OR v_old.admin_id IS NULL THEN
    RAISE EXCEPTION 'Empréstimo sem trabalhador ou empresa definidos. Corrija o cadastro antes de renovar.';
  END IF;
  PERFORM public._assert_loan_scope_caller(v_old.admin_id, v_old.worker_id);

  IF v_old.status NOT IN ('open','overdue') OR COALESCE(v_old.remaining_balance,0) <= 0.01 THEN
    RAISE EXCEPTION 'Este empréstimo já foi quitado ou renovado. A renovação não foi repetida.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.loans WHERE renewed_from_loan_id = v_old.id AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'Já existe uma renovação registrada para este contrato. A renovação não foi repetida.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.loans WHERE client_id = v_old.client_id AND id <> v_old.id AND status IN ('open','overdue')) THEN
    RAISE EXCEPTION 'O cliente possui outro empréstimo ativo. A renovação foi cancelada.';
  END IF;

  SELECT * INTO v_dc FROM public.daily_cash
   WHERE cash_date = p_cash_date AND worker_id = v_old.worker_id AND admin_id = v_old.admin_id
   FOR UPDATE;
  IF NOT FOUND OR v_dc.status <> 'open' THEN
    RAISE EXCEPTION 'Não existe caixa aberto em % para o trabalhador deste contrato. Abra o caixa antes de renovar.', to_char(p_cash_date,'DD/MM/YYYY');
  END IF;

  SELECT id INTO v_cb_id FROM public.cash_balance
   WHERE admin_id = v_old.admin_id AND worker_id = v_old.worker_id FOR UPDATE;
  IF v_cb_id IS NULL THEN
    INSERT INTO public.cash_balance (worker_id, admin_id, available_cash, money_lent, interest_receivable, penalty_receivable, ledger_base_amount)
    VALUES (v_old.worker_id, v_old.admin_id, 0, 0, 0, 0, 0) RETURNING id INTO v_cb_id;
  END IF;

  PERFORM 1 FROM public.installments WHERE loan_id = v_old.id FOR UPDATE;

  SELECT COALESCE(SUM(GREATEST(0, amount - COALESCE(paid_amount,0))),0) INTO v_pen
    FROM public.penalties
   WHERE loan_id = v_old.id AND cancelled_at IS NULL AND COALESCE(paid,false) = false;
  v_pen := v_pen + COALESCE((SELECT SUM(GREATEST(0, amount - COALESCE(paid_amount,0)))
    FROM public.installments
   WHERE loan_id = v_old.id AND is_penalty = true AND status NOT IN ('paid','cancelled','renegotiated')),0);
  IF v_pen > 0.01 THEN
    RAISE EXCEPTION 'Este contrato possui multa pendente de R$ %. Receba ou cancele a multa antes de renovar.', to_char(v_pen,'FM999999990.00');
  END IF;

  SELECT count(*), COALESCE(SUM(x.amount),0) INTO v_inst_count, v_inst_sum
    FROM jsonb_to_recordset(p_installments) AS x(number int, amount numeric, due_date date);
  IF v_inst_count <> p_installment_count THEN
    RAISE EXCEPTION 'Quantidade de parcelas (%) difere do informado (%).', v_inst_count, p_installment_count;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_installments) AS x(number int, amount numeric, due_date date)
              WHERE x.number IS NULL OR x.amount IS NULL OR x.amount <= 0 OR x.due_date IS NULL) THEN
    RAISE EXCEPTION 'Existem parcelas sem número, valor ou vencimento.';
  END IF;
  IF abs(v_inst_sum - p_total_amount) > 0.01 * p_installment_count + 0.01 THEN
    RAISE EXCEPTION 'Soma das parcelas (R$ %) difere do total (R$ %).', to_char(v_inst_sum,'FM999999990.00'), to_char(p_total_amount,'FM999999990.00');
  END IF;

  v_remaining := round(COALESCE(v_old.remaining_balance,0), 2);
  v_paid := round(COALESCE(p_paid_amount,0), 2);
  IF v_paid < 0 THEN RAISE EXCEPTION 'Valor pago inválido.'; END IF;
  IF v_paid > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'Valor pago (R$ %) é maior que o saldo do contrato (R$ %).', to_char(v_paid,'FM999999990.00'), to_char(v_remaining,'FM999999990.00');
  END IF;
  v_paid := LEAST(v_paid, v_remaining);
  v_absorbed := round(v_remaining - v_paid, 2);
  IF p_amount + 0.01 < v_absorbed THEN
    RAISE EXCEPTION 'Renovação insuficiente. Faltam R$ % para quitar o empréstimo atual.', to_char(v_absorbed - p_amount,'FM999999990.00');
  END IF;
  v_released := GREATEST(0, round(p_amount - v_absorbed, 2));

  SELECT name INTO v_client_name FROM public.clients WHERE id = v_old.client_id;

  v_old_before := jsonb_build_object('status', v_old.status, 'remaining_balance', v_old.remaining_balance);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'amount', i.amount,
           'status', i.status, 'paid_amount', COALESCE(i.paid_amount,0), 'paid_at', i.paid_at, 'is_penalty', i.is_penalty) ORDER BY i.number), '[]'::jsonb)
    INTO v_inst_before FROM public.installments i WHERE i.loan_id = v_old.id;

  -- Progresso congelado para o evento "pagamento" da renovação
  SELECT count(*), COALESCE(SUM(CASE WHEN i.amount > 0 THEN LEAST(1, COALESCE(i.paid_amount,0)/i.amount) ELSE 0 END),0), MAX(i.amount)
    INTO v_reg_total, v_units_before, v_inst_amt
    FROM public.installments i
   WHERE i.loan_id = v_old.id AND i.is_penalty = false AND i.status NOT IN ('cancelled','renegotiated');
  v_units_before := round(v_units_before, 2);
  v_units_after := CASE WHEN COALESCE(v_inst_amt,0) > 0 THEN LEAST(v_reg_total, round(v_units_before + v_paid / v_inst_amt, 2)) ELSE v_units_before END;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('installment_id', q.id, 'number', q.number, 'amount', q.amount,
           'paid_amount_before', q.pb, 'amount_applied', q.applied, 'paid_amount_after', q.pb + q.applied, 'status_after', 'paid') ORDER BY q.number), '[]'::jsonb)
    INTO v_affected
    FROM (SELECT i.id, i.number, i.amount, COALESCE(i.paid_amount,0) AS pb,
                 round(LEAST(i.amount - COALESCE(i.paid_amount,0), GREATEST(0, v_paid - COALESCE(SUM(i.amount - COALESCE(i.paid_amount,0)) OVER (ORDER BY i.number ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))),2) AS applied
            FROM public.installments i
           WHERE i.loan_id = v_old.id AND i.is_penalty = false AND i.status IN ('pending','overdue','partial')) q
   WHERE q.applied > 0;

  v_paid_base := CASE WHEN v_old.is_imported_ongoing THEN
      COALESCE(v_old.initial_remaining_balance, GREATEST(0, COALESCE(v_old.total_amount,0) - COALESCE(v_old.amount_already_paid,0)))
    ELSE COALESCE(v_old.total_amount,0) END;
  v_int_total := GREATEST(0, COALESCE(v_old.total_amount,0) - COALESCE(v_old.amount,0));
  v_paid_before := GREATEST(0, v_paid_base - v_remaining);
  v_int_rem := GREATEST(0, v_int_total - v_paid_before);
  v_to_int := LEAST(v_remaining, v_int_rem);
  v_to_pr := v_remaining - v_to_int;

  v_paid_at := (p_cash_date::text || 'T12:00:00')::timestamp AT TIME ZONE 'UTC';

  UPDATE public.loans SET remaining_balance = 0, status = 'paid' WHERE id = v_old.id;
  UPDATE public.installments
     SET status = 'paid', paid_amount = amount, paid_at = COALESCE(paid_at, v_paid_at)
   WHERE loan_id = v_old.id AND is_penalty = false AND status IN ('pending','overdue','partial');

  INSERT INTO public.loans (client_id, amount, interest_type, interest_value, total_amount, installment_count,
    payment_type, loan_date, first_due_date, renewed_from_loan_id, observation, user_id, worker_id, admin_id,
    route_id, is_imported_ongoing, amount_already_paid, status)
  VALUES (v_old.client_id, p_amount, p_interest_type, COALESCE(p_interest_value,0), p_total_amount, p_installment_count,
    p_payment_type, p_cash_date, p_first_due_date, v_old.id, NULLIF(btrim(COALESCE(p_observation,'')),''), v_uid,
    v_old.worker_id, v_old.admin_id, v_old.route_id, false, 0, 'open')
  RETURNING * INTO v_new;
  IF v_new.worker_id IS DISTINCT FROM v_old.worker_id OR v_new.admin_id IS DISTINCT FROM v_old.admin_id THEN
    RAISE EXCEPTION 'Escopo do novo contrato divergente do contrato antigo. A renovação foi cancelada.';
  END IF;

  INSERT INTO public.installments (loan_id, number, amount, due_date, status, paid_amount, paid_at, is_penalty)
  SELECT v_new.id, x.number, round(x.amount,2), x.due_date, 'pending', 0, NULL, false
    FROM jsonb_to_recordset(p_installments) AS x(number int, amount numeric, due_date date);

  IF v_paid > 0.009 THEN
    INSERT INTO public.cash_movements (type, amount, client_id, loan_id, observation, cash_date, user_id, worker_id, admin_id)
    VALUES ('recebimento_normal', v_paid, v_old.client_id, v_old.id,
            COALESCE(NULLIF(btrim(COALESCE(p_payment_observation,'')),''), 'Renovação - pagamento ' || COALESCE(v_client_name,'')),
            p_cash_date, v_uid, v_old.worker_id, v_old.admin_id)
    RETURNING id INTO v_pay_mov;
    INSERT INTO public.daily_events (cash_date, event_type, client_id, loan_id, amount_in, amount_out, observation, origin,
      cash_movement_id, metadata, user_id, worker_id, admin_id)
    VALUES (p_cash_date, 'pagamento', v_old.client_id, v_old.id, v_paid, 0,
      COALESCE(NULLIF(btrim(COALESCE(p_payment_observation,'')),''), 'Renovação - pagamento ' || COALESCE(v_client_name,'')),
      'renovacao', v_pay_mov,
      jsonb_build_object('payment_amount', v_paid, 'cash_date', p_cash_date, 'admin_id', v_old.admin_id,
        'worker_id', v_old.worker_id, 'client_id', v_old.client_id, 'client_name', v_client_name,
        'loan_id', v_old.id, 'renewal', true, 'old_loan_id', v_old.id, 'new_loan_id', v_new.id,
        'remaining_balance_before', v_remaining, 'remaining_balance_after', round(v_remaining - v_paid,2),
        'cash_movement_id', v_pay_mov,
        'installment_amount', v_inst_amt, 'total_installments', v_reg_total,
        'progress_units_before', v_units_before, 'progress_units_after', v_units_after,
        'installment_progress_before', replace(trim_scale(round(v_units_before::numeric,2))::text,'.',',') || '/' || v_reg_total,
        'installment_progress_after', replace(trim_scale(round(v_units_after::numeric,2))::text,'.',',') || '/' || v_reg_total,
        'installments_advanced', round(v_units_after - v_units_before, 2),
        'paid_installments_before', floor(v_units_before), 'paid_installments_after', floor(v_units_after),
        'total_paid_before', v_paid_before, 'total_paid_after', v_paid_before + v_paid,
        'loan_total_amount', v_paid_base,
        'affected_installments', v_affected,
        'next_due_date', NULL, 'absorbed_by_renewal', v_absorbed),
      v_uid, v_old.worker_id, v_old.admin_id)
    RETURNING id INTO v_pay_ev;
    UPDATE public.cash_movements SET daily_event_id = v_pay_ev WHERE id = v_pay_mov;
  END IF;

  IF v_absorbed > 0.009 THEN
    INSERT INTO public.daily_events (cash_date, event_type, client_id, loan_id, amount_in, amount_out, observation, origin,
      metadata, user_id, worker_id, admin_id)
    VALUES (p_cash_date, 'renovacao_absorvida', v_old.client_id, v_old.id, 0, 0,
      'Saldo absorvido pela renovação - ' || COALESCE(v_client_name,'') || ' (R$ ' || to_char(v_absorbed,'FM999999990.00') || ')',
      'renovacao',
      jsonb_build_object('absorbed_amount', v_absorbed, 'old_loan_id', v_old.id, 'new_loan_id', v_new.id,
        'client_id', v_old.client_id, 'client_name', v_client_name, 'cash_date', p_cash_date,
        'note', 'Absorção contábil — não representa entrada de caixa.'),
      v_uid, v_old.worker_id, v_old.admin_id)
    RETURNING id INTO v_abs_ev;
  END IF;

  IF v_released > 0.009 THEN
    INSERT INTO public.cash_movements (type, amount, client_id, loan_id, observation, cash_date, user_id, worker_id, admin_id)
    VALUES ('emprestimo', -v_released, v_old.client_id, v_new.id,
            'Renovação - liberado R$ ' || to_char(v_released,'FM999999990.00') || ' para ' || COALESCE(v_client_name,''),
            p_cash_date, v_uid, v_old.worker_id, v_old.admin_id)
    RETURNING id INTO v_rel_mov;
  END IF;

  v_meta := jsonb_build_object(
    'loan_type', 'renovacao', 'tx', 'renew_loan_tx',
    'loan_id', v_new.id, 'new_loan_id', v_new.id, 'old_loan_id', v_old.id,
    'client_id', v_old.client_id, 'client_name', v_client_name,
    'worker_id', v_old.worker_id, 'admin_id', v_old.admin_id,
    'principal_amount', p_amount, 'total_amount', p_total_amount,
    'interest_type', p_interest_type, 'interest_value', COALESCE(p_interest_value,0), 'payment_type', p_payment_type,
    'last_due_date', (SELECT max(x.due_date) FROM jsonb_to_recordset(p_installments) AS x(number int, amount numeric, due_date date)),
    'installments', p_installment_count, 'installment_amount', round(p_total_amount / p_installment_count, 2),
    'receivable_created', p_total_amount, 'first_due_date', p_first_due_date,
    'released_amount', v_released,
    'renew_paid_amount', v_paid, 'renew_absorbed_amount', v_absorbed, 'renew_additional_cash', v_released,
    'old_remaining_before', v_remaining,
    'old_receivable_interest_closed', v_to_int, 'old_receivable_principal_closed', v_to_pr,
    'payment_movement_id', v_pay_mov, 'payment_event_id', v_pay_ev,
    'absorbed_event_id', v_abs_ev, 'release_movement_id', v_rel_mov,
    'old_loan_before', v_old_before, 'old_installments_before', v_inst_before,
    'created_at', now());

  INSERT INTO public.daily_events (cash_date, event_type, client_id, loan_id, amount_in, amount_out, observation, origin,
    cash_movement_id, metadata, user_id, worker_id, admin_id)
  VALUES (p_cash_date, 'renovacao', v_old.client_id, v_new.id, 0, v_released,
    'Renovação - ' || COALESCE(v_client_name,'') || ' - Pago: R$ ' || to_char(v_paid,'FM999999990.00')
      || ' | Faltava: R$ ' || to_char(v_remaining,'FM999999990.00')
      || ' | Novo: R$ ' || to_char(p_amount,'FM999999990.00')
      || ' | Liberado: R$ ' || to_char(v_released,'FM999999990.00'),
    'novo_emprestimo', v_rel_mov, v_meta, v_uid, v_old.worker_id, v_old.admin_id)
  RETURNING id INTO v_ev;
  IF v_rel_mov IS NOT NULL THEN
    UPDATE public.cash_movements SET daily_event_id = v_ev WHERE id = v_rel_mov;
  END IF;
  UPDATE public.daily_events SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('renewal_event_id', v_ev)
   WHERE id IN (v_pay_ev, v_abs_ev);

  UPDATE public.cash_balance
     SET money_lent = money_lent - v_to_pr + p_amount,
         interest_receivable = interest_receivable - v_to_int + (p_total_amount - p_amount),
         updated_at = now()
   WHERE id = v_cb_id;

  SELECT status, remaining_balance INTO v_chk FROM public.loans WHERE id = v_old.id;
  IF v_chk.status <> 'paid' OR COALESCE(v_chk.remaining_balance,0) > 0.01 THEN
    RAISE EXCEPTION 'O contrato antigo não ficou quitado. A renovação foi cancelada.';
  END IF;
  IF (SELECT count(*) FROM public.installments WHERE loan_id = v_new.id) <> p_installment_count THEN
    RAISE EXCEPTION 'As parcelas do novo contrato não foram criadas por completo. A renovação foi cancelada.';
  END IF;

  PERFORM public.log_audit('renovar_emprestimo', 'loan', v_new.id,
    jsonb_build_object('old_loan_id', v_old.id, 'old_loan', v_old_before, 'old_installments', v_inst_before),
    jsonb_build_object('new_loan_id', v_new.id, 'old_loan_id', v_old.id, 'old_status', 'paid', 'old_remaining_balance', 0,
      'paid_amount', v_paid, 'absorbed_amount', v_absorbed, 'released_amount', v_released,
      'principal_amount', p_amount, 'total_amount', p_total_amount, 'installment_count', p_installment_count,
      'payment_type', p_payment_type, 'cash_date', p_cash_date, 'renewal_event_id', v_ev,
      'payment_movement_id', v_pay_mov, 'release_movement_id', v_rel_mov),
    'Renovação - ' || COALESCE(v_client_name,''), v_old.worker_id);

  RETURN jsonb_build_object('new_loan_id', v_new.id, 'old_loan_id', v_old.id, 'old_status', 'paid',
    'old_remaining_balance', 0, 'installments_created', p_installment_count,
    'paid_amount', v_paid, 'absorbed_amount', v_absorbed, 'released_amount', v_released,
    'renewal_event_id', v_ev, 'payment_movement_id', v_pay_mov, 'release_movement_id', v_rel_mov);
END $function$;