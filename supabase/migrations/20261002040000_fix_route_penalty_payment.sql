-- Correção: pagamento com multa (Rota do Dia).
-- Mesmas assinaturas e permissões. Idempotência por operation_id, conferência
-- da parcela agregada de multa com penalties, snapshot exato para estorno.

CREATE OR REPLACE FUNCTION public.register_route_payment_with_penalty_tx(
  p_installment_id uuid,
  p_cash_date date,
  p_mode text,
  p_regular_amount numeric,
  p_penalty_amount numeric,
  p_observation text,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_caller_worker  uuid;
  v_caller_admin   uuid;
  v_inst           public.installments%ROWTYPE;
  v_inst_after     public.installments%ROWTYPE;
  v_loan           public.loans%ROWTYPE;
  v_loan_after     public.loans%ROWTYPE;
  v_cb             public.cash_balance%ROWTYPE;
  v_pen_inst       public.installments%ROWTYPE;
  v_pen_inst_id    uuid;
  v_pen_inst_created boolean := false;
  v_client_name    text;
  v_regular        numeric := COALESCE(p_regular_amount, 0);
  v_penalty        numeric := COALESCE(p_penalty_amount, 0);
  v_reg_result     jsonb;
  v_reg_movement   uuid;
  v_reg_event      uuid;
  v_pending_before numeric := 0;
  v_pending_after  numeric := 0;
  v_used_old       numeric := 0;
  v_new_part       numeric := 0;
  v_left           numeric;
  v_apply          numeric;
  v_new_penalty_id uuid;
  v_old_rows       jsonb := '[]'::jsonb;
  v_pen_paid_new   numeric;
  v_pen_status     text;
  v_paid_at        timestamptz;
  v_max_number     integer;
  v_movement_id    uuid;
  v_event_id       uuid;
  v_metadata       jsonb;
  v_obs            text;
  v_existing       public.daily_events%ROWTYPE;
  v_pen_snapshot   jsonb;
  v_detail_pending numeric := 0;
  r                record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_operation_id IS NULL THEN RAISE EXCEPTION 'Identificador da operação não informado.'; END IF;
  IF p_installment_id IS NULL THEN RAISE EXCEPTION 'Parcela não informada.'; END IF;
  IF p_cash_date IS NULL THEN RAISE EXCEPTION 'Data do caixa não informada.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('regular_and_penalty','penalty_only') THEN
    RAISE EXCEPTION 'Modo de pagamento inválido.';
  END IF;
  IF p_penalty_amount IS NULL OR p_penalty_amount <= 0 THEN
    RAISE EXCEPTION 'O valor da multa deve ser maior que zero.';
  END IF;
  IF p_regular_amount IS NULL OR p_regular_amount < 0 THEN
    RAISE EXCEPTION 'Valor da parcela inválido.';
  END IF;
  IF p_mode = 'regular_and_penalty' AND p_regular_amount <= 0 THEN
    RAISE EXCEPTION 'O valor da parcela deve ser maior que zero.';
  END IF;
  IF p_mode = 'penalty_only' AND p_regular_amount <> 0 THEN
    RAISE EXCEPTION 'No pagamento somente de multa o valor da parcela deve ser zero.';
  END IF;
  v_regular := round(v_regular, 2);
  v_penalty := round(v_penalty, 2);
  IF v_penalty <= 0 THEN RAISE EXCEPTION 'O valor da multa deve ser maior que zero.'; END IF;

  -- Serializa operações com o mesmo operation_id.
  PERFORM pg_advisory_xact_lock(hashtextextended('route_penalty_op:' || p_operation_id::text, 0));

  SELECT * INTO v_inst FROM public.installments WHERE id = p_installment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parcela não encontrada.'; END IF;
  IF v_inst.is_penalty THEN RAISE EXCEPTION 'Selecione a parcela regular, não a parcela de multa.'; END IF;

  SELECT * INTO v_loan FROM public.loans WHERE id = v_inst.loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo não encontrado.'; END IF;
  IF v_loan.worker_id IS NULL OR v_loan.admin_id IS NULL THEN
    RAISE EXCEPTION 'Empréstimo sem trabalhador ou empresa definidos.';
  END IF;

  v_caller_worker := public.get_worker_id(v_uid);
  v_caller_admin  := public.get_admin_id(v_uid);
  IF v_caller_worker IS NOT NULL THEN
    IF v_loan.worker_id <> v_caller_worker OR v_loan.admin_id IS DISTINCT FROM v_caller_admin THEN
      RAISE EXCEPTION 'access denied';
    END IF;
  ELSIF public.has_role(v_uid, 'admin'::app_role) THEN
    IF v_caller_admin IS NULL OR v_loan.admin_id <> v_caller_admin THEN
      RAISE EXCEPTION 'access denied';
    END IF;
  ELSE
    RAISE EXCEPTION 'access denied';
  END IF;

  -- Idempotência: mesma operação + mesmos dados => devolve o resultado já gravado.
  SELECT * INTO v_existing FROM public.daily_events
   WHERE event_type = 'recebimento_multa' AND reverses_event_id IS NULL
     AND metadata->>'operation_id' = p_operation_id::text
   LIMIT 1;
  IF FOUND THEN
    IF v_existing.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Esta operação já foi estornada e não pode ser reutilizada. Inicie um novo pagamento.';
    END IF;
    IF v_existing.installment_id IS DISTINCT FROM p_installment_id
       OR v_existing.cash_date IS DISTINCT FROM p_cash_date
       OR (v_existing.metadata->>'payment_mode') IS DISTINCT FROM p_mode
       OR round(COALESCE((v_existing.metadata->>'regular_amount')::numeric, -1), 2) <> v_regular
       OR round(COALESCE((v_existing.metadata->>'penalty_amount')::numeric, -1), 2) <> v_penalty
       OR v_existing.admin_id IS DISTINCT FROM v_loan.admin_id
       OR v_existing.worker_id IS DISTINCT FROM v_loan.worker_id THEN
      RAISE EXCEPTION 'Este identificador de operação já foi usado com dados diferentes. Nada foi registrado.';
    END IF;
    RETURN jsonb_build_object(
      'idempotent', true,
      'operation_id', p_operation_id,
      'payment_mode', v_existing.metadata->>'payment_mode',
      'regular_amount', (v_existing.metadata->>'regular_amount')::numeric,
      'penalty_amount', (v_existing.metadata->>'penalty_amount')::numeric,
      'total_received', (v_existing.metadata->>'total_received')::numeric,
      'penalty_movement_id', v_existing.cash_movement_id,
      'penalty_event_id', v_existing.id,
      'regular_movement_id', NULLIF(v_existing.metadata->>'regular_movement_id','')::uuid,
      'regular_event_id', NULLIF(v_existing.metadata->>'regular_event_id','')::uuid,
      'penalty_used_existing', (v_existing.metadata->>'penalty_used_existing')::numeric,
      'penalty_created_paid', (v_existing.metadata->>'penalty_created_paid')::numeric,
      'remaining_balance_after', (v_existing.metadata->>'remaining_balance_after')::numeric
    );
  END IF;
  IF EXISTS (SELECT 1 FROM public.daily_events
              WHERE metadata->>'operation_id' = p_operation_id::text) THEN
    RAISE EXCEPTION 'Este identificador de operação já foi usado em outro registro. Nada foi registrado.';
  END IF;

  IF v_loan.status NOT IN ('open','overdue') THEN
    RAISE EXCEPTION 'Empréstimo inativo não pode receber pagamento.';
  END IF;
  IF COALESCE(v_loan.remaining_balance, 0) <= 0.01 THEN
    RAISE EXCEPTION 'Empréstimo sem saldo em aberto não pode receber pagamento.';
  END IF;
  IF v_inst.status NOT IN ('pending','partial','overdue') THEN
    RAISE EXCEPTION 'A parcela % não está em aberto (situação: %). Nada foi registrado.', v_inst.number, v_inst.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.daily_cash dc
     WHERE dc.cash_date = p_cash_date AND dc.worker_id = v_loan.worker_id
       AND dc.admin_id = v_loan.admin_id AND dc.status = 'open'
  ) THEN
    RAISE EXCEPTION 'Não existe caixa aberto para % neste dia. Abra o caixa antes de registrar o pagamento.', p_cash_date;
  END IF;

  SELECT * INTO v_cb FROM public.cash_balance
   WHERE worker_id = v_loan.worker_id AND admin_id = v_loan.admin_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Saldo de caixa não encontrado para este trabalhador.'; END IF;

  SELECT name INTO v_client_name FROM public.clients WHERE id = v_loan.client_id;
  v_paid_at := (p_cash_date::text || 'T12:00:00')::timestamp AT TIME ZONE 'UTC';

  -- 1) Parcela regular (lógica existente, mesma transação)
  IF p_mode = 'regular_and_penalty' THEN
    v_reg_result := public.register_payment_tx(
      v_loan.id, v_regular, v_loan.client_id, p_cash_date, 'rota_multa', p_installment_id,
      COALESCE(NULLIF(trim(p_observation), ''), 'Pagamento - ' || COALESCE(v_client_name, '')));
    v_reg_movement := (v_reg_result->>'movement_id')::uuid;
    v_reg_event    := (v_reg_result->>'event_id')::uuid;
  END IF;

  SELECT * INTO v_loan_after FROM public.loans WHERE id = v_loan.id;
  SELECT * INTO v_inst_after FROM public.installments WHERE id = p_installment_id;

  -- 2) Multa: sistema existente (parcela is_penalty agregada + penalties)
  SELECT * INTO v_pen_inst FROM public.installments
   WHERE loan_id = v_loan.id AND is_penalty = true
     AND status NOT IN ('cancelled','renegotiated')
   ORDER BY number LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    v_pen_inst_id := v_pen_inst.id;
    v_pending_before := GREATEST(0, COALESCE(v_pen_inst.amount,0) - COALESCE(v_pen_inst.paid_amount,0));
    v_pen_snapshot := jsonb_build_object('existed', true, 'id', v_pen_inst.id,
      'amount', v_pen_inst.amount, 'paid_amount', COALESCE(v_pen_inst.paid_amount,0),
      'status', v_pen_inst.status, 'paid_at', v_pen_inst.paid_at);
  ELSE
    v_pen_snapshot := jsonb_build_object('existed', false);
  END IF;

  -- Conferência: parcela agregada de multa x detalhamento ativo de penalties.
  PERFORM 1 FROM public.penalties WHERE loan_id = v_loan.id AND cancelled_at IS NULL ORDER BY id FOR UPDATE;
  SELECT COALESCE(SUM(GREATEST(amount - COALESCE(paid_amount,0), 0)), 0) INTO v_detail_pending
    FROM public.penalties WHERE loan_id = v_loan.id AND cancelled_at IS NULL;
  IF abs(round(v_detail_pending, 2) - round(v_pending_before, 2)) > 0.01 THEN
    RAISE EXCEPTION 'Multas deste empréstimo estão divergentes: parcela de multa em aberto R$ %, detalhamento das multas em aberto R$ %. Nada foi registrado. Corrija as multas antes de receber.',
      to_char(v_pending_before, 'FM999999990.00'), to_char(v_detail_pending, 'FM999999990.00');
  END IF;

  v_used_old := LEAST(v_penalty, v_pending_before);
  v_new_part := round(v_penalty - v_used_old, 2);

  -- Abate multas antigas (penalties) em ordem de criação
  v_left := v_used_old;
  FOR r IN
    SELECT * FROM public.penalties
     WHERE loan_id = v_loan.id AND cancelled_at IS NULL
       AND COALESCE(paid_amount,0) < amount - 0.005
     ORDER BY created_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0.005;
    v_apply := LEAST(v_left, r.amount - COALESCE(r.paid_amount,0));
    UPDATE public.penalties
       SET paid_amount = COALESCE(paid_amount,0) + v_apply,
           paid = (COALESCE(paid_amount,0) + v_apply) >= amount - 0.005,
           paid_at = CASE WHEN (COALESCE(paid_amount,0) + v_apply) >= amount - 0.005 THEN v_paid_at ELSE paid_at END
     WHERE id = r.id;
    v_old_rows := v_old_rows || jsonb_build_object(
      'penalty_id', r.id, 'applied', v_apply, 'amount_before', r.amount,
      'paid_amount_before', COALESCE(r.paid_amount,0), 'paid_before', r.paid, 'paid_at_before', r.paid_at);
    v_left := v_left - v_apply;
  END LOOP;
  IF v_left > 0.005 THEN
    RAISE EXCEPTION 'Não foi possível distribuir R$ % da multa antiga nos registros de multa. Nada foi registrado.',
      to_char(v_left, 'FM999999990.00');
  END IF;

  -- Parte nova: multa criada e paga na mesma operação
  IF v_new_part > 0.005 THEN
    INSERT INTO public.penalties (loan_id, installment_id, amount, observation, user_id, worker_id, admin_id,
                                  penalty_type, paid, paid_at, paid_amount)
    VALUES (v_loan.id, p_installment_id, v_new_part,
            COALESCE(NULLIF(trim(p_observation), ''), 'Multa recebida na rota'),
            v_uid, v_loan.worker_id, v_loan.admin_id, 'fixed', true, v_paid_at, v_new_part)
    RETURNING id INTO v_new_penalty_id;

    UPDATE public.installments SET penalty_amount = COALESCE(penalty_amount,0) + v_new_part
     WHERE id = p_installment_id;

    IF v_pen_inst_id IS NULL THEN
      SELECT COALESCE(MAX(number),0) INTO v_max_number FROM public.installments WHERE loan_id = v_loan.id;
      INSERT INTO public.installments (loan_id, number, amount, due_date, is_penalty, status, paid_amount)
      VALUES (v_loan.id, v_max_number + 1, v_new_part, p_cash_date, true, 'pending', 0)
      RETURNING * INTO v_pen_inst;
      v_pen_inst_id := v_pen_inst.id;
      v_pen_inst_created := true;
    ELSE
      UPDATE public.installments SET amount = amount + v_new_part WHERE id = v_pen_inst_id
      RETURNING * INTO v_pen_inst;
    END IF;
  END IF;

  v_pen_paid_new := COALESCE(v_pen_inst.paid_amount,0) + v_penalty;
  IF v_pen_paid_new > v_pen_inst.amount + 0.005 THEN
    RAISE EXCEPTION 'Valor pago da multa ultrapassaria o valor da multa. Operação cancelada.';
  END IF;
  v_pen_status := CASE WHEN v_pen_paid_new >= v_pen_inst.amount - 0.005 THEN 'paid' ELSE 'partial' END;
  UPDATE public.installments
     SET paid_amount = LEAST(v_pen_paid_new, amount),
         status = v_pen_status,
         paid_at = CASE WHEN v_pen_status = 'paid' THEN v_paid_at ELSE paid_at END
   WHERE id = v_pen_inst_id;
  v_pending_after := GREATEST(0, v_pen_inst.amount - LEAST(v_pen_paid_new, v_pen_inst.amount));

  v_obs := 'Multa - ' || COALESCE(v_client_name, '');

  INSERT INTO public.cash_movements (type, amount, client_id, loan_id, installment_id, observation,
                                     cash_date, user_id, worker_id, admin_id)
  VALUES ('recebimento_multa', v_penalty, v_loan.client_id, v_loan.id, p_installment_id, v_obs,
          p_cash_date, v_uid, v_loan.worker_id, v_loan.admin_id)
  RETURNING id INTO v_movement_id;

  v_metadata := jsonb_build_object(
    'operation_id', p_operation_id,
    'payment_mode', p_mode,
    'client_id', v_loan.client_id,
    'client_name', v_client_name,
    'loan_id', v_loan.id,
    'installment_id', p_installment_id,
    'installment_number', v_inst.number,
    'cash_date', p_cash_date,
    'admin_id', v_loan.admin_id,
    'worker_id', v_loan.worker_id,
    'regular_amount', v_regular,
    'penalty_amount', v_penalty,
    'penalty_paid_amount', v_penalty,
    'total_received', v_regular + v_penalty,
    'remaining_balance_before', v_loan.remaining_balance,
    'remaining_balance_after', v_loan_after.remaining_balance,
    'installment_before', jsonb_build_object('paid_amount', v_inst.paid_amount, 'status', v_inst.status, 'paid_at', v_inst.paid_at),
    'installment_after', jsonb_build_object('paid_amount', v_inst_after.paid_amount, 'status', v_inst_after.status, 'paid_at', v_inst_after.paid_at),
    'penalty_balance_before', v_pending_before,
    'penalty_balance_after', v_pending_after,
    'penalty_used_existing', v_used_old,
    'penalty_created_paid', v_new_part,
    'penalty_created_id', v_new_penalty_id,
    'penalty_installment_id', v_pen_inst_id,
    'penalty_installment_created', v_pen_inst_created,
    'penalty_installment_before', jsonb_build_object(
        'amount', CASE WHEN v_pen_inst_created THEN 0 ELSE v_pen_inst.amount - v_new_part END,
        'paid_amount', CASE WHEN v_pen_inst_created THEN 0 ELSE v_pen_inst.paid_amount END),
    'penalty_rows_applied', v_old_rows,
    'penalty_installment_snapshot', v_pen_snapshot,
    'snapshot_version', 2,
    'cash_movement_id', v_movement_id,
    'regular_movement_id', v_reg_movement,
    'regular_event_id', v_reg_event,
    'recorded_at', now()
  );

  INSERT INTO public.daily_events (cash_date, event_type, client_id, loan_id, installment_id,
                                   amount_in, amount_out, observation, origin, cash_movement_id,
                                   metadata, user_id, worker_id, admin_id)
  VALUES (p_cash_date, 'recebimento_multa', v_loan.client_id, v_loan.id, p_installment_id,
          v_penalty, 0, v_obs, 'rota_multa', v_movement_id, v_metadata, v_uid,
          v_loan.worker_id, v_loan.admin_id)
  RETURNING id INTO v_event_id;

  UPDATE public.cash_movements SET daily_event_id = v_event_id WHERE id = v_movement_id;
  UPDATE public.daily_events
     SET metadata = metadata || jsonb_build_object('daily_event_id', v_event_id)
   WHERE id = v_event_id;

  IF v_reg_event IS NOT NULL THEN
    UPDATE public.daily_events
       SET metadata = metadata || jsonb_build_object(
             'operation_id', p_operation_id, 'payment_mode', p_mode,
             'regular_amount', v_regular, 'penalty_amount', v_penalty,
             'total_received', v_regular + v_penalty,
             'penalty_event_id', v_event_id, 'penalty_movement_id', v_movement_id)
     WHERE id = v_reg_event;
  END IF;

  -- available_cash é derivado do ledger (sobe exatamente v_penalty).
  -- penalty_receivable cai apenas pela multa antiga quitada.
  UPDATE public.cash_balance
     SET penalty_receivable = penalty_receivable - v_used_old, updated_at = now()
   WHERE id = v_cb.id;

  PERFORM public.log_audit('pagamento_com_multa', 'loan', v_loan.id, NULL,
    v_metadata || jsonb_build_object('daily_event_id', v_event_id), p_observation, v_loan.worker_id);

  RETURN jsonb_build_object(
    'operation_id', p_operation_id,
    'payment_mode', p_mode,
    'regular_amount', v_regular,
    'penalty_amount', v_penalty,
    'total_received', v_regular + v_penalty,
    'penalty_movement_id', v_movement_id,
    'penalty_event_id', v_event_id,
    'regular_movement_id', v_reg_movement,
    'regular_event_id', v_reg_event,
    'penalty_used_existing', v_used_old,
    'penalty_created_paid', v_new_part,
    'remaining_balance_after', v_loan_after.remaining_balance
  );
END $function$;

CREATE OR REPLACE FUNCTION public.reverse_route_payment_with_penalty_tx(
  p_operation_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid           uuid := auth.uid();
  v_caller_worker uuid;
  v_caller_admin  uuid;
  v_reason        text := NULLIF(trim(COALESCE(p_reason,'')), '');
  v_pen_event     public.daily_events%ROWTYPE;
  v_reg_event     public.daily_events%ROWTYPE;
  v_pen_mov       public.cash_movements%ROWTYPE;
  v_loan          public.loans%ROWTYPE;
  v_cb            public.cash_balance%ROWTYPE;
  v_pen_inst      public.installments%ROWTYPE;
  v_meta          jsonb;
  v_mode          text;
  v_penalty       numeric;
  v_used_old      numeric;
  v_new_part      numeric;
  v_new_pen_id    uuid;
  v_new_paid      numeric;
  v_new_amount    numeric;
  v_new_status    text;
  v_dep           record;
  v_reg_rev       jsonb;
  v_rev_mov_id    uuid;
  v_rev_event_id  uuid;
  v_today_sp      date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_snap          jsonb;
  v_exp_amount    numeric;
  v_exp_paid      numeric;
  v_cur_pen       record;
  r               jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_operation_id IS NULL THEN RAISE EXCEPTION 'Operação não informada.'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Informe o motivo do estorno (mínimo 3 caracteres).';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('route_penalty_op:' || p_operation_id::text, 0));

  SELECT * INTO v_pen_event FROM public.daily_events
   WHERE event_type = 'recebimento_multa' AND reverses_event_id IS NULL
     AND metadata->>'operation_id' = p_operation_id::text
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operação não encontrada.'; END IF;
  IF v_pen_event.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'Esta operação já foi estornada.'; END IF;

  v_meta     := v_pen_event.metadata;
  v_mode     := v_meta->>'payment_mode';
  v_penalty  := (v_meta->>'penalty_amount')::numeric;
  v_used_old := COALESCE((v_meta->>'penalty_used_existing')::numeric, 0);
  v_new_part := COALESCE((v_meta->>'penalty_created_paid')::numeric, 0);
  v_new_pen_id := NULLIF(v_meta->>'penalty_created_id','')::uuid;

  SELECT * INTO v_loan FROM public.loans WHERE id = v_pen_event.loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo não encontrado.'; END IF;

  v_caller_worker := public.get_worker_id(v_uid);
  v_caller_admin  := public.get_admin_id(v_uid);
  IF v_caller_worker IS NOT NULL THEN
    IF v_loan.worker_id <> v_caller_worker OR v_loan.admin_id IS DISTINCT FROM v_caller_admin THEN
      RAISE EXCEPTION 'access denied';
    END IF;
  ELSIF public.has_role(v_uid, 'admin'::app_role) THEN
    IF v_caller_admin IS NULL OR v_loan.admin_id <> v_caller_admin THEN
      RAISE EXCEPTION 'access denied';
    END IF;
  ELSE
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_pen_event.admin_id IS DISTINCT FROM v_loan.admin_id OR v_pen_event.worker_id IS DISTINCT FROM v_loan.worker_id THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.daily_cash dc
     WHERE dc.cash_date = v_pen_event.cash_date AND dc.worker_id = v_loan.worker_id
       AND dc.admin_id = v_loan.admin_id AND dc.status = 'open'
  ) THEN
    RAISE EXCEPTION 'O caixa de % não está aberto. Solicite a reabertura antes de desfazer esta operação.', v_pen_event.cash_date;
  END IF;

  IF v_mode = 'regular_and_penalty' THEN
    SELECT * INTO v_reg_event FROM public.daily_events
     WHERE id = NULLIF(v_meta->>'regular_event_id','')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pagamento da parcela desta operação não encontrado. Nada foi alterado.'; END IF;
    IF v_reg_event.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'O pagamento da parcela desta operação já foi estornado separadamente. Nada foi alterado.';
    END IF;
  ELSIF v_mode <> 'penalty_only' THEN
    RAISE EXCEPTION 'Modo da operação desconhecido. Nada foi alterado.';
  END IF;

  -- Operação posterior dependente no mesmo empréstimo bloqueia o estorno.
  SELECT de.event_type, de.cash_date, de.created_at INTO v_dep
    FROM public.daily_events de
   WHERE de.loan_id = v_loan.id
     AND de.created_at > v_pen_event.created_at
     AND de.reversed_at IS NULL
     AND de.reverses_event_id IS NULL
     AND de.id <> v_pen_event.id
     AND (v_reg_event.id IS NULL OR de.id <> v_reg_event.id)
   ORDER BY de.created_at LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Não é possível desfazer: existe uma operação posterior neste empréstimo (% em %). Desfaça-a primeiro.',
      v_dep.event_type, to_char(v_dep.cash_date, 'DD/MM/YYYY');
  END IF;

  SELECT * INTO v_pen_mov FROM public.cash_movements WHERE id = v_pen_event.cash_movement_id FOR UPDATE;
  IF NOT FOUND OR v_pen_mov.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movimentação da multa não encontrada ou já estornada. Nada foi alterado.';
  END IF;

  SELECT * INTO v_cb FROM public.cash_balance
   WHERE worker_id = v_loan.worker_id AND admin_id = v_loan.admin_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Saldo de caixa não encontrado.'; END IF;

  -- 1) Desfaz a multa
  SELECT * INTO v_pen_inst FROM public.installments
   WHERE id = (v_meta->>'penalty_installment_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parcela de multa não encontrada. Nada foi alterado.'; END IF;
  IF COALESCE(v_pen_inst.paid_amount,0) < v_penalty - 0.005 THEN
    RAISE EXCEPTION 'A multa paga atual é menor que o valor da operação. Nada foi alterado.';
  END IF;

  v_snap := v_meta->'penalty_installment_snapshot';
  IF v_snap IS NOT NULL AND jsonb_typeof(v_snap) = 'object' THEN
    -- Estorno exato a partir do estado congelado antes da operação.
    IF COALESCE((v_snap->>'existed')::boolean, false) THEN
      v_exp_amount := (v_snap->>'amount')::numeric + v_new_part;
      v_exp_paid   := (v_snap->>'paid_amount')::numeric + v_penalty;
    ELSE
      v_exp_amount := v_new_part;
      v_exp_paid   := v_penalty;
    END IF;
    IF abs(v_pen_inst.amount - v_exp_amount) > 0.005 OR abs(COALESCE(v_pen_inst.paid_amount,0) - v_exp_paid) > 0.005 THEN
      RAISE EXCEPTION 'A multa deste empréstimo mudou depois desta operação (valor R$ %, pago R$ %; esperado R$ %, pago R$ %). Nada foi alterado.',
        to_char(v_pen_inst.amount, 'FM999999990.00'), to_char(COALESCE(v_pen_inst.paid_amount,0), 'FM999999990.00'),
        to_char(v_exp_amount, 'FM999999990.00'), to_char(v_exp_paid, 'FM999999990.00');
    END IF;
    IF COALESCE((v_snap->>'existed')::boolean, false) THEN
      UPDATE public.installments
         SET amount = (v_snap->>'amount')::numeric,
             paid_amount = (v_snap->>'paid_amount')::numeric,
             status = v_snap->>'status',
             paid_at = NULLIF(v_snap->>'paid_at','')::timestamptz
       WHERE id = v_pen_inst.id;
    ELSE
      UPDATE public.installments
         SET amount = 0, paid_amount = 0, status = 'cancelled', paid_at = NULL
       WHERE id = v_pen_inst.id;
    END IF;
  ELSE

  v_new_paid   := round(COALESCE(v_pen_inst.paid_amount,0) - v_penalty, 2);
  v_new_amount := round(v_pen_inst.amount - v_new_part, 2);
  IF v_new_amount <= 0.005 THEN
    v_new_status := 'cancelled'; v_new_amount := 0; v_new_paid := 0;
  ELSIF v_new_paid >= v_new_amount - 0.005 THEN v_new_status := 'paid';
  ELSIF v_new_paid > 0.005 THEN v_new_status := 'partial';
  ELSIF v_pen_inst.due_date < v_today_sp THEN v_new_status := 'overdue';
  ELSE v_new_status := 'pending'; END IF;

  UPDATE public.installments
     SET amount = v_new_amount, paid_amount = v_new_paid, status = v_new_status,
         paid_at = CASE WHEN v_new_status = 'paid' THEN paid_at ELSE NULL END
   WHERE id = v_pen_inst.id;
  END IF;

  IF v_new_part > 0.005 THEN
    UPDATE public.installments
       SET penalty_amount = GREATEST(0, COALESCE(penalty_amount,0) - v_new_part)
     WHERE id = (v_meta->>'installment_id')::uuid;
    IF v_new_pen_id IS NOT NULL THEN
      SELECT * INTO v_cur_pen FROM public.penalties WHERE id = v_new_pen_id FOR UPDATE;
      IF NOT FOUND OR v_cur_pen.cancelled_at IS NOT NULL OR abs(COALESCE(v_cur_pen.paid_amount,0) - v_new_part) > 0.005 THEN
        RAISE EXCEPTION 'A multa criada nesta operação foi alterada depois. Nada foi alterado.';
      END IF;
      UPDATE public.penalties
         SET paid = false, paid_amount = 0, paid_at = NULL,
             cancelled_at = now(), cancelled_by = v_uid,
             cancellation_reason = 'Estorno: ' || v_reason
       WHERE id = v_new_pen_id;
    END IF;
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(v_meta->'penalty_rows_applied','[]'::jsonb)) LOOP
    SELECT * INTO v_cur_pen FROM public.penalties WHERE id = (r->>'penalty_id')::uuid FOR UPDATE;
    IF NOT FOUND OR abs(COALESCE(v_cur_pen.paid_amount,0) - ((r->>'paid_amount_before')::numeric + (r->>'applied')::numeric)) > 0.005
       OR (r ? 'amount_before' AND abs(v_cur_pen.amount - (r->>'amount_before')::numeric) > 0.005) THEN
      RAISE EXCEPTION 'Uma multa antiga foi alterada depois desta operação. Nada foi alterado.';
    END IF;
    UPDATE public.penalties
       SET paid_amount = (r->>'paid_amount_before')::numeric,
           paid = COALESCE((r->>'paid_before')::boolean, false),
           paid_at = NULLIF(r->>'paid_at_before','')::timestamptz
     WHERE id = (r->>'penalty_id')::uuid;
  END LOOP;

  INSERT INTO public.cash_movements (type, amount, client_id, loan_id, installment_id, observation,
                                     cash_date, user_id, worker_id, admin_id, reverses_movement_id, reversal_reason)
  VALUES ('estorno_pagamento', -v_penalty, v_pen_mov.client_id, v_pen_mov.loan_id, v_pen_mov.installment_id,
          'Estorno de multa — Motivo: ' || v_reason, v_pen_event.cash_date, v_uid,
          v_loan.worker_id, v_loan.admin_id, v_pen_mov.id, v_reason)
  RETURNING id INTO v_rev_mov_id;

  INSERT INTO public.daily_events (cash_date, event_type, client_id, loan_id, installment_id,
                                   amount_in, amount_out, observation, origin, cash_movement_id,
                                   metadata, user_id, worker_id, admin_id, reverses_event_id, reversal_reason)
  VALUES (v_pen_event.cash_date, 'estorno_pagamento', v_pen_event.client_id, v_pen_event.loan_id,
          v_pen_event.installment_id, 0, v_penalty, 'Estorno de multa — Motivo: ' || v_reason,
          'estorno', v_rev_mov_id,
          jsonb_build_object('reverses_movement_id', v_pen_mov.id, 'reverses_event_id', v_pen_event.id,
                             'original_type', 'recebimento_multa', 'original_amount', v_penalty,
                             'reversal_amount', -v_penalty, 'operation_id', p_operation_id,
                             'payment_mode', v_mode, 'restored_penalty_receivable', v_used_old,
                             'cancelled_penalty_id', v_new_pen_id, 'reversal_reason', v_reason,
                             'original_metadata', v_meta),
          v_uid, v_loan.worker_id, v_loan.admin_id, v_pen_event.id, v_reason)
  RETURNING id INTO v_rev_event_id;

  UPDATE public.cash_movements SET daily_event_id = v_rev_event_id WHERE id = v_rev_mov_id;
  UPDATE public.cash_movements
     SET reversed_at = now(), reversed_by = v_uid, reversal_movement_id = v_rev_mov_id, reversal_reason = v_reason
   WHERE id = v_pen_mov.id;
  UPDATE public.daily_events
     SET reversed_at = now(), reversed_by = v_uid, reversal_event_id = v_rev_event_id, reversal_reason = v_reason
   WHERE id = v_pen_event.id;

  UPDATE public.cash_balance
     SET penalty_receivable = penalty_receivable + v_used_old, updated_at = now()
   WHERE id = v_cb.id;

  -- 2) Desfaz a parcela regular com o estorno existente (mesma transação)
  IF v_mode = 'regular_and_penalty' THEN
    v_reg_rev := public.reverse_cash_movement_tx(v_reg_event.cash_movement_id, v_reason);
  END IF;

  PERFORM public.log_audit('estorno_pagamento_com_multa', 'loan', v_loan.id, v_meta,
    jsonb_build_object('operation_id', p_operation_id, 'payment_mode', v_mode,
                       'penalty_reversal_movement_id', v_rev_mov_id,
                       'penalty_reversal_event_id', v_rev_event_id,
                       'regular_reversal', v_reg_rev, 'reason', v_reason),
    v_reason, v_loan.worker_id);

  RETURN jsonb_build_object(
    'operation_id', p_operation_id,
    'payment_mode', v_mode,
    'penalty_reversal_movement_id', v_rev_mov_id,
    'penalty_reversal_event_id', v_rev_event_id,
    'regular_reversal', v_reg_rev,
    'restored_penalty_receivable', v_used_old,
    'cancelled_penalty_id', v_new_pen_id
  );
END $function$;

REVOKE ALL ON FUNCTION public.register_route_payment_with_penalty_tx(uuid, date, text, numeric, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_route_payment_with_penalty_tx(uuid, date, text, numeric, numeric, text, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.reverse_route_payment_with_penalty_tx(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_route_payment_with_penalty_tx(uuid, text) TO authenticated, service_role;
