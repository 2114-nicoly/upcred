
CREATE OR REPLACE FUNCTION public.apply_loan_payment(p_loan_id uuid, p_amount numeric)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_current numeric; v_new numeric; v_w uuid; v_a uuid; v_loan record;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'payment amount must be greater than zero'; END IF;
  SELECT id, worker_id, admin_id INTO v_loan FROM public.loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'loan not found'; END IF;
  v_w := public.get_worker_id(auth.uid()); v_a := public.get_admin_id(auth.uid());
  IF NOT (
    public.is_super_admin(auth.uid())
    OR (v_w IS NOT NULL AND v_loan.worker_id = v_w AND v_loan.admin_id IS NOT DISTINCT FROM v_a)
    OR (v_w IS NULL AND public.has_role(auth.uid(),'admin'::app_role) AND v_a IS NOT NULL AND v_loan.admin_id = v_a)
  ) THEN RAISE EXCEPTION 'access denied'; END IF;
  SELECT remaining_balance INTO v_current FROM public.loans WHERE id = p_loan_id FOR UPDATE;
  v_new := GREATEST(0, v_current - p_amount);
  UPDATE public.loans SET remaining_balance = v_new,
    status = CASE WHEN v_new <= 0.01 THEN 'paid' WHEN status='paid' THEN 'open' ELSE status END
  WHERE id = p_loan_id;
  RETURN v_new;
END; $function$;

CREATE OR REPLACE FUNCTION public.reverse_loan_payment(p_loan_id uuid, p_amount numeric)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_current numeric; v_total numeric; v_new numeric; v_w uuid; v_a uuid; v_loan record;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'payment amount must be greater than zero'; END IF;
  SELECT id, worker_id, admin_id INTO v_loan FROM public.loans WHERE id = p_loan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'loan not found'; END IF;
  v_w := public.get_worker_id(auth.uid()); v_a := public.get_admin_id(auth.uid());
  IF NOT (
    public.is_super_admin(auth.uid())
    OR (v_w IS NOT NULL AND v_loan.worker_id = v_w AND v_loan.admin_id IS NOT DISTINCT FROM v_a)
    OR (v_w IS NULL AND public.has_role(auth.uid(),'admin'::app_role) AND v_a IS NOT NULL AND v_loan.admin_id = v_a)
  ) THEN RAISE EXCEPTION 'access denied'; END IF;
  SELECT remaining_balance, total_amount INTO v_current, v_total FROM public.loans WHERE id = p_loan_id FOR UPDATE;
  v_new := LEAST(COALESCE(v_total,0), v_current + p_amount);
  UPDATE public.loans SET remaining_balance = v_new,
    status = CASE WHEN v_new <= 0.01 THEN 'paid' WHEN status='paid' THEN 'open' ELSE status END
  WHERE id = p_loan_id;
  RETURN v_new;
END; $function$;

-- Autorização comum: trabalhador do escopo exato ou administrador da empresa
CREATE OR REPLACE FUNCTION public._assert_loan_scope_caller(p_admin uuid, p_worker uuid)
 RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_w uuid; v_a uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  v_w := public.get_worker_id(v_uid); v_a := public.get_admin_id(v_uid);
  IF v_w IS NOT NULL THEN
    IF p_worker IS DISTINCT FROM v_w OR p_admin IS DISTINCT FROM v_a THEN RAISE EXCEPTION 'access denied'; END IF;
  ELSIF public.has_role(v_uid, 'admin'::app_role) THEN
    IF v_a IS NULL OR p_admin IS DISTINCT FROM v_a THEN RAISE EXCEPTION 'access denied'; END IF;
  ELSE
    RAISE EXCEPTION 'access denied';
  END IF;
END $function$;
REVOKE EXECUTE ON FUNCTION public._assert_loan_scope_caller(uuid, uuid) FROM PUBLIC, anon, authenticated;

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
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_old_loan_id IS NULL THEN RAISE EXCEPTION 'Empréstimo a renovar não informado.'; END IF;
  IF p_cash_date IS NULL THEN RAISE EXCEPTION 'Data do caixa não informada.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Informe o valor do novo empréstimo.'; END IF;
  IF p_total_amount IS NULL OR p_total_amount < p_amount THEN RAISE EXCEPTION 'Valor total do novo empréstimo inválido.'; END IF;
  IF p_installment_count IS NULL OR p_installment_count <= 0 THEN RAISE EXCEPTION 'Quantidade de parcelas inválida.'; END IF;
  IF p_installments IS NULL OR jsonb_typeof(p_installments) <> 'array' THEN RAISE EXCEPTION 'Parcelas do novo empréstimo não informadas.'; END IF;

  -- Serializa renovações do mesmo contrato (clique repetido)
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

  -- Multa pendente bloqueia antes de qualquer gravação
  SELECT COALESCE(SUM(GREATEST(0, amount - COALESCE(paid_amount,0))),0) INTO v_pen
    FROM public.penalties
   WHERE loan_id = v_old.id AND cancelled_at IS NULL AND COALESCE(paid,false) = false;
  v_pen := v_pen + COALESCE((SELECT SUM(GREATEST(0, amount - COALESCE(paid_amount,0)))
    FROM public.installments
   WHERE loan_id = v_old.id AND is_penalty = true AND status NOT IN ('paid','cancelled','renegotiated')),0);
  IF v_pen > 0.01 THEN
    RAISE EXCEPTION 'Este contrato possui multa pendente de R$ %. Receba ou cancele a multa antes de renovar.', to_char(v_pen,'FM999999990.00');
  END IF;

  -- Parcelas do novo contrato
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

  -- Valores reais relidos do banco
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

  -- Divisão juros/principal do saldo encerrado (pago + absorvido)
  v_paid_base := CASE WHEN v_old.is_imported_ongoing THEN
      COALESCE(v_old.initial_remaining_balance, GREATEST(0, COALESCE(v_old.total_amount,0) - COALESCE(v_old.amount_already_paid,0)))
    ELSE COALESCE(v_old.total_amount,0) END;
  v_int_total := GREATEST(0, COALESCE(v_old.total_amount,0) - COALESCE(v_old.amount,0));
  v_paid_before := GREATEST(0, v_paid_base - v_remaining);
  v_int_rem := GREATEST(0, v_int_total - v_paid_before);
  v_to_int := LEAST(v_remaining, v_int_rem);
  v_to_pr := v_remaining - v_to_int;

  v_paid_at := (p_cash_date::text || 'T12:00:00')::timestamp AT TIME ZONE 'UTC';

  -- Quita o contrato antigo
  UPDATE public.loans SET remaining_balance = 0, status = 'paid' WHERE id = v_old.id;
  UPDATE public.installments
     SET status = 'paid', paid_amount = amount, paid_at = COALESCE(paid_at, v_paid_at)
   WHERE loan_id = v_old.id AND is_penalty = false AND status IN ('pending','overdue','partial');

  -- Cria o novo contrato
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

  -- Pagamento real do cliente (entrada de caixa)
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
        'remaining_balance_before', v_remaining, 'remaining_balance_after', round(v_remaining - v_paid,2)),
      v_uid, v_old.worker_id, v_old.admin_id)
    RETURNING id INTO v_pay_ev;
    UPDATE public.cash_movements SET daily_event_id = v_pay_ev WHERE id = v_pay_mov;
  END IF;

  -- Saldo absorvido (não é caixa)
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

  -- Somente o dinheiro adicional sai do caixa
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

  -- Valores a receber do escopo exato (available_cash é derivado pelo ledger)
  UPDATE public.cash_balance
     SET money_lent = money_lent - v_to_pr + p_amount,
         interest_receivable = interest_receivable - v_to_int + (p_total_amount - p_amount),
         updated_at = now()
   WHERE id = v_cb_id;

  -- Conferência final
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

CREATE OR REPLACE FUNCTION public.reverse_renewal_tx(p_event_id uuid, p_reason text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text;
  v_ev public.daily_events%ROWTYPE;
  v_new public.loans%ROWTYPE;
  v_old public.loans%ROWTYPE;
  v_dc record;
  v_cb_id uuid;
  v_block record;
  v_legacy boolean;
  v_pay_ids uuid[] := '{}';
  v_abs_ids uuid[] := '{}';
  v_pay_total numeric := 0;
  v_abs_total numeric := 0;
  v_restore numeric;
  v_new_bal numeric;
  v_paid_base numeric; v_int_total numeric; v_paid_now numeric; v_paid_rest numeric;
  v_to_int numeric; v_to_pr numeric;
  v_remaining numeric; v_paid_at timestamptz;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_rel public.cash_movements%ROWTYPE;
  v_rev_mov uuid; v_rev_ev uuid; v_first_rev_ev uuid;
  m record; r record; v_orig_ev uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_event_id IS NULL THEN RAISE EXCEPTION 'Evento de renovação não informado.'; END IF;
  v_reason := btrim(COALESCE(p_reason,''));
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Informe o motivo do estorno (mínimo 3 caracteres).'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('reverse_renewal:' || p_event_id::text, 0));

  SELECT * INTO v_ev FROM public.daily_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evento de renovação não encontrado.'; END IF;
  IF v_ev.event_type <> 'renovacao' THEN RAISE EXCEPTION 'O evento selecionado não é uma renovação.'; END IF;
  IF v_ev.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'Esta renovação já foi desfeita.'; END IF;
  IF v_ev.loan_id IS NULL THEN RAISE EXCEPTION 'Renovação sem contrato novo vinculado. O estorno foi cancelado.'; END IF;

  SELECT * INTO v_new FROM public.loans WHERE id = v_ev.loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contrato novo não encontrado.'; END IF;
  IF v_new.renewed_from_loan_id IS NULL THEN RAISE EXCEPTION 'O contrato novo não está vinculado a um contrato antigo. O estorno foi cancelado.'; END IF;
  SELECT * INTO v_old FROM public.loans WHERE id = v_new.renewed_from_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contrato antigo não encontrado.'; END IF;

  IF v_new.admin_id IS DISTINCT FROM v_ev.admin_id OR v_new.worker_id IS DISTINCT FROM v_ev.worker_id
     OR v_old.admin_id IS DISTINCT FROM v_new.admin_id OR v_old.worker_id IS DISTINCT FROM v_new.worker_id THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  PERFORM public._assert_loan_scope_caller(v_new.admin_id, v_new.worker_id);

  IF v_new.status = 'cancelled' THEN RAISE EXCEPTION 'O contrato novo já está cancelado.'; END IF;

  SELECT * INTO v_dc FROM public.daily_cash
   WHERE cash_date = v_ev.cash_date AND worker_id IS NOT DISTINCT FROM v_new.worker_id AND admin_id = v_new.admin_id FOR UPDATE;
  IF NOT FOUND OR v_dc.status <> 'open' THEN
    RAISE EXCEPTION 'O caixa de % não está aberto. Solicite a reabertura antes de desfazer esta renovação.', to_char(v_ev.cash_date,'DD/MM/YYYY');
  END IF;
  SELECT id INTO v_cb_id FROM public.cash_balance WHERE admin_id = v_new.admin_id AND worker_id IS NOT DISTINCT FROM v_new.worker_id FOR UPDATE;
  IF v_cb_id IS NULL THEN RAISE EXCEPTION 'Saldo de caixa do escopo não encontrado. O estorno foi cancelado.'; END IF;

  PERFORM 1 FROM public.installments WHERE loan_id IN (v_new.id, v_old.id) FOR UPDATE;

  -- ===== Bloqueios de atividade posterior =====
  SELECT m2.id, m2.type, m2.amount, m2.cash_date INTO v_block FROM public.cash_movements m2
   WHERE m2.loan_id = v_new.id AND m2.id IS DISTINCT FROM v_ev.cash_movement_id
     AND m2.reversed_at IS NULL AND m2.reverses_movement_id IS NULL
   ORDER BY m2.created_at LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Não é seguro desfazer: o contrato novo já possui a movimentação % de R$ % em % (id %). Desfaça essa movimentação antes.',
      v_block.type, to_char(v_block.amount,'FM999999990.00'), to_char(v_block.cash_date,'DD/MM/YYYY'), v_block.id;
  END IF;
  SELECT i.number, i.paid_amount INTO v_block FROM public.installments i
   WHERE i.loan_id = v_new.id AND COALESCE(i.paid_amount,0) > 0.005 ORDER BY i.number LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Não é seguro desfazer: a parcela % do contrato novo já recebeu R$ %.', v_block.number, to_char(v_block.paid_amount,'FM999999990.00');
  END IF;
  SELECT p.id, p.amount INTO v_block FROM public.penalties p WHERE p.loan_id = v_new.id AND p.cancelled_at IS NULL LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Não é seguro desfazer: o contrato novo possui multa de R$ % (id %). Cancele a multa antes.', to_char(v_block.amount,'FM999999990.00'), v_block.id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.installments WHERE loan_id = v_new.id AND is_penalty = true AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'Não é seguro desfazer: o contrato novo possui parcela de multa registrada.';
  END IF;
  SELECT l.id, l.status INTO v_block FROM public.loans l WHERE l.renewed_from_loan_id = v_new.id AND l.status <> 'cancelled' LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Não é seguro desfazer: o contrato novo já foi renovado/renegociado posteriormente (contrato %).', v_block.id;
  END IF;
  SELECT d.id, d.event_type, d.cash_date INTO v_block FROM public.daily_events d
   WHERE d.loan_id = v_new.id AND d.id <> v_ev.id AND d.reversed_at IS NULL AND d.reverses_event_id IS NULL
     AND d.event_type IN ('pagamento','recebimento_multa','multa_adicionada','renovacao','renegociacao')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Não é seguro desfazer: existe o lançamento "%" em % no contrato novo (id %).', v_block.event_type, to_char(v_block.cash_date,'DD/MM/YYYY'), v_block.id;
  END IF;

  -- ===== Identifica pagamento e absorção do contrato antigo =====
  v_legacy := NOT (COALESCE(v_ev.metadata,'{}'::jsonb) ? 'old_loan_before');
  IF NOT v_legacy THEN
    IF (v_ev.metadata->>'payment_movement_id') IS NOT NULL THEN
      v_pay_ids := ARRAY[(v_ev.metadata->>'payment_movement_id')::uuid];
    END IF;
    IF (v_ev.metadata->>'absorbed_event_id') IS NOT NULL THEN
      v_abs_ids := ARRAY[(v_ev.metadata->>'absorbed_event_id')::uuid];
    END IF;
  ELSE
    SELECT COALESCE(array_agg(cm.id), '{}') INTO v_pay_ids FROM public.cash_movements cm
     WHERE cm.loan_id = v_old.id AND cm.type = 'recebimento_normal' AND cm.cash_date = v_ev.cash_date
       AND cm.reversed_at IS NULL AND cm.reverses_movement_id IS NULL
       AND cm.created_at >= v_new.created_at - interval '1 minute'
       AND EXISTS (SELECT 1 FROM public.daily_events d WHERE d.cash_movement_id = cm.id AND d.origin = 'renovacao');
    SELECT COALESCE(array_agg(d.id), '{}') INTO v_abs_ids FROM public.daily_events d
     WHERE d.loan_id = v_old.id AND d.event_type = 'renovacao_absorvida' AND d.reversed_at IS NULL
       AND d.cash_date = v_ev.cash_date
       AND (d.metadata->>'new_loan_id' = v_new.id::text
            OR (d.metadata->>'new_loan_id' IS NULL AND d.created_at >= v_new.created_at - interval '1 minute'));
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_pay_total FROM public.cash_movements
   WHERE id = ANY(v_pay_ids) AND reversed_at IS NULL;
  SELECT COALESCE(SUM(COALESCE((metadata->>'absorbed_amount')::numeric,0)),0) INTO v_abs_total
    FROM public.daily_events WHERE id = ANY(v_abs_ids) AND reversed_at IS NULL;

  -- Contrato antigo não pode ter movimentação posterior à renovação
  SELECT cm.id, cm.type, cm.amount, cm.cash_date INTO v_block FROM public.cash_movements cm
   WHERE cm.loan_id = v_old.id AND cm.reversed_at IS NULL AND cm.reverses_movement_id IS NULL
     AND NOT (cm.id = ANY(v_pay_ids)) AND cm.created_at > v_new.created_at
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Não é seguro desfazer: o contrato antigo recebeu a movimentação % de R$ % em % após a renovação (id %).',
      v_block.type, to_char(v_block.amount,'FM999999990.00'), to_char(v_block.cash_date,'DD/MM/YYYY'), v_block.id;
  END IF;

  -- ===== Restaura o contrato antigo =====
  v_paid_base := CASE WHEN v_old.is_imported_ongoing THEN
      COALESCE(v_old.initial_remaining_balance, GREATEST(0, COALESCE(v_old.total_amount,0) - COALESCE(v_old.amount_already_paid,0)))
    ELSE COALESCE(v_old.total_amount,0) END;
  v_int_total := GREATEST(0, COALESCE(v_old.total_amount,0) - COALESCE(v_old.amount,0));

  IF NOT v_legacy THEN
    IF v_old.status <> 'paid' OR COALESCE(v_old.remaining_balance,0) > 0.01 THEN
      RAISE EXCEPTION 'Não é seguro desfazer: o contrato antigo foi alterado depois da renovação (status %, saldo R$ %).', v_old.status, to_char(v_old.remaining_balance,'FM999999990.00');
    END IF;
    v_new_bal := COALESCE((v_ev.metadata->'old_loan_before'->>'remaining_balance')::numeric, 0);
    v_restore := round(v_new_bal - COALESCE(v_old.remaining_balance,0), 2);
    UPDATE public.loans
       SET remaining_balance = v_new_bal, status = COALESCE(v_ev.metadata->'old_loan_before'->>'status','open')
     WHERE id = v_old.id;
    UPDATE public.installments i
       SET status = s.status, paid_amount = s.paid_amount, paid_at = s.paid_at
      FROM jsonb_to_recordset(v_ev.metadata->'old_installments_before') AS s(id uuid, status text, paid_amount numeric, paid_at timestamptz)
     WHERE i.id = s.id AND i.loan_id = v_old.id;
  ELSE
    v_restore := round(v_pay_total + v_abs_total, 2);
    IF v_restore <= 0.009 THEN
      RAISE EXCEPTION 'Não foi possível identificar com segurança o pagamento ou o saldo absorvido do contrato antigo nesta renovação. Nada foi alterado.';
    END IF;
    v_new_bal := LEAST(COALESCE(v_old.total_amount,0), COALESCE(v_old.remaining_balance,0) + v_restore);
    UPDATE public.loans SET remaining_balance = v_new_bal,
           status = CASE WHEN v_new_bal <= 0.01 THEN 'paid' WHEN status IN ('paid','renewed') THEN 'open' ELSE status END
     WHERE id = v_old.id;
    v_remaining := GREATEST(0, v_paid_base - v_new_bal);
    v_paid_at := (v_ev.cash_date::text || 'T12:00:00')::timestamp AT TIME ZONE 'UTC';
    FOR r IN SELECT * FROM public.installments WHERE loan_id = v_old.id AND is_penalty = false ORDER BY number LOOP
      IF r.status IN ('cancelled','renegotiated') THEN CONTINUE; END IF;
      IF v_remaining >= r.amount - 0.01 THEN
        UPDATE public.installments SET paid_amount = r.amount, status = 'paid', paid_at = COALESCE(r.paid_at, v_paid_at) WHERE id = r.id;
        v_remaining := v_remaining - r.amount;
      ELSIF v_remaining > 0.01 THEN
        UPDATE public.installments SET paid_amount = v_remaining, status = 'partial', paid_at = COALESCE(r.paid_at, v_paid_at) WHERE id = r.id;
        v_remaining := 0;
      ELSE
        UPDATE public.installments SET paid_amount = 0,
               status = CASE WHEN r.due_date < v_today THEN 'overdue' ELSE 'pending' END, paid_at = NULL WHERE id = r.id;
      END IF;
    END LOOP;
  END IF;

  v_paid_now  := GREATEST(0, v_paid_base - COALESCE(v_old.remaining_balance,0));
  v_paid_rest := GREATEST(0, v_paid_base - v_new_bal);
  v_to_int := GREATEST(0, LEAST(v_paid_now, v_int_total) - LEAST(v_paid_rest, v_int_total));
  v_to_pr  := GREATEST(0, v_restore - v_to_int);

  -- ===== Contrapartida do dinheiro liberado (primeiro, devolve ao caixa) =====
  IF v_ev.cash_movement_id IS NOT NULL THEN
    SELECT * INTO v_rel FROM public.cash_movements WHERE id = v_ev.cash_movement_id FOR UPDATE;
    IF FOUND AND v_rel.reversed_at IS NULL THEN
      INSERT INTO public.cash_movements (type, amount, client_id, loan_id, observation, cash_date, user_id, worker_id, admin_id, reverses_movement_id, reversal_reason)
      VALUES ('estorno_manual', -v_rel.amount, v_rel.client_id, v_rel.loan_id,
              'Estorno de renovação (valor liberado) — Motivo: ' || v_reason, v_ev.cash_date, v_uid, v_rel.worker_id, v_rel.admin_id, v_rel.id, v_reason)
      RETURNING id INTO v_rev_mov;
      INSERT INTO public.daily_events (cash_date, event_type, client_id, loan_id, amount_in, amount_out, observation, origin,
        cash_movement_id, metadata, user_id, worker_id, admin_id, reverses_event_id, reversal_reason)
      VALUES (v_ev.cash_date, 'estorno_manual', v_rel.client_id, v_rel.loan_id, abs(v_rel.amount), 0,
        'Estorno de renovação (valor liberado) — Motivo: ' || v_reason, 'estorno', v_rev_mov,
        jsonb_build_object('reverses_movement_id', v_rel.id, 'reverses_event_id', v_ev.id, 'original_type', v_rel.type,
          'original_amount', v_rel.amount, 'reversal_amount', -v_rel.amount, 'net_effect', 0, 'renewal_reversal', true),
        v_uid, v_rel.worker_id, v_rel.admin_id, v_ev.id, v_reason)
      RETURNING id INTO v_rev_ev;
      UPDATE public.cash_movements SET daily_event_id = v_rev_ev WHERE id = v_rev_mov;
      UPDATE public.cash_movements SET reversed_at = now(), reversed_by = v_uid, reversal_movement_id = v_rev_mov, reversal_reason = v_reason WHERE id = v_rel.id;
      v_first_rev_ev := v_rev_ev;
    END IF;
  END IF;

  -- ===== Contrapartida do pagamento registrado no antigo =====
  FOR m IN SELECT * FROM public.cash_movements WHERE id = ANY(v_pay_ids) AND reversed_at IS NULL FOR UPDATE LOOP
    SELECT d.id INTO v_orig_ev FROM public.daily_events d
     WHERE (d.id = m.daily_event_id OR d.cash_movement_id = m.id) AND d.reverses_event_id IS NULL LIMIT 1;
    INSERT INTO public.cash_movements (type, amount, client_id, loan_id, observation, cash_date, user_id, worker_id, admin_id, reverses_movement_id, reversal_reason)
    VALUES ('estorno_pagamento', -m.amount, m.client_id, m.loan_id,
            'Estorno de renovação (pagamento) — Motivo: ' || v_reason, v_ev.cash_date, v_uid, m.worker_id, m.admin_id, m.id, v_reason)
    RETURNING id INTO v_rev_mov;
    INSERT INTO public.daily_events (cash_date, event_type, client_id, loan_id, amount_in, amount_out, observation, origin,
      cash_movement_id, metadata, user_id, worker_id, admin_id, reverses_event_id, reversal_reason)
    VALUES (v_ev.cash_date, 'estorno_pagamento', m.client_id, m.loan_id, 0, abs(m.amount),
      'Estorno de renovação (pagamento) — Motivo: ' || v_reason, 'estorno', v_rev_mov,
      jsonb_build_object('reverses_movement_id', m.id, 'reverses_event_id', v_orig_ev, 'original_type', m.type,
        'original_amount', m.amount, 'reversal_amount', -m.amount, 'net_effect', 0, 'renewal_reversal', true,
        'renewal_event_id', v_ev.id),
      v_uid, m.worker_id, m.admin_id, v_orig_ev, v_reason)
    RETURNING id INTO v_rev_ev;
    UPDATE public.cash_movements SET daily_event_id = v_rev_ev WHERE id = v_rev_mov;
    UPDATE public.cash_movements SET reversed_at = now(), reversed_by = v_uid, reversal_movement_id = v_rev_mov, reversal_reason = v_reason WHERE id = m.id;
    IF v_orig_ev IS NOT NULL THEN
      UPDATE public.daily_events SET reversed_at = now(), reversed_by = v_uid, reversal_event_id = v_rev_ev, reversal_reason = v_reason WHERE id = v_orig_ev;
    END IF;
    v_first_rev_ev := COALESCE(v_first_rev_ev, v_rev_ev);
  END LOOP;

  -- Eventos originais marcados como estornados
  UPDATE public.daily_events SET reversed_at = now(), reversed_by = v_uid, reversal_reason = v_reason
   WHERE id = ANY(v_abs_ids) AND reversed_at IS NULL;
  UPDATE public.daily_events SET reversed_at = now(), reversed_by = v_uid, reversal_event_id = v_first_rev_ev, reversal_reason = v_reason
   WHERE id = v_ev.id;

  -- Cancela o contrato novo sem apagar histórico
  UPDATE public.installments SET status = 'cancelled' WHERE loan_id = v_new.id;
  UPDATE public.loans SET status = 'cancelled' WHERE id = v_new.id;

  -- Valores a receber do escopo exato
  UPDATE public.cash_balance
     SET money_lent = money_lent - COALESCE(v_new.amount,0) + v_to_pr,
         interest_receivable = interest_receivable - GREATEST(0, COALESCE(v_new.total_amount,0) - COALESCE(v_new.amount,0)) + v_to_int,
         updated_at = now()
   WHERE id = v_cb_id;

  PERFORM public.log_audit('desfazer_renovacao', 'loan', v_new.id,
    jsonb_build_object('new_loan_id', v_new.id, 'new_status', v_new.status, 'old_loan_id', v_old.id,
      'old_status', v_old.status, 'old_remaining_balance', v_old.remaining_balance, 'renewal_event_id', v_ev.id),
    jsonb_build_object('new_status', 'cancelled', 'old_remaining_balance', v_new_bal, 'restored_amount', v_restore,
      'reversed_payment_movements', to_jsonb(v_pay_ids), 'reversed_absorbed_events', to_jsonb(v_abs_ids),
      'release_movement_id', v_ev.cash_movement_id, 'legacy', v_legacy, 'reason', v_reason),
    v_reason, v_new.worker_id);

  RETURN jsonb_build_object('new_loan_id', v_new.id, 'old_loan_id', v_old.id, 'old_remaining_balance', v_new_bal,
    'restored_amount', v_restore, 'legacy', v_legacy,
    'reversed_payment_movements', to_jsonb(v_pay_ids), 'reversed_absorbed_events', to_jsonb(v_abs_ids));
END $function$;

REVOKE EXECUTE ON FUNCTION public.renew_loan_tx(uuid, date, numeric, numeric, text, numeric, numeric, integer, text, date, jsonb, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reverse_renewal_tx(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_loan_tx(uuid, date, numeric, numeric, text, numeric, numeric, integer, text, date, jsonb, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_renewal_tx(uuid, text) TO authenticated, service_role;
