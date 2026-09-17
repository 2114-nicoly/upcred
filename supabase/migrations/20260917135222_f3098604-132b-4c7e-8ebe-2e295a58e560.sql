-- 1) REPARO SEGURO DO CAIXA (Brandon / BrasilCred / 2026-09-15)
DO $$
DECLARE
  v_admin      uuid;
  v_worker     uuid;
  v_dc_id      uuid;
  v_count      int;
  v_status     text;
  v_opening    numeric;
  v_day_net    numeric;
  v_cb_id      uuid;
  v_base_old   numeric;
  v_avail_old  numeric;
  v_ledger_net numeric;
  v_expected   numeric;
  v_new_base   numeric;
  v_avail_new  numeric;
BEGIN
  SELECT a.id INTO v_admin FROM public.admins a WHERE a.nome = 'BrasilCred';
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Reparo cancelado: empresa BrasilCred não encontrada.';
  END IF;

  SELECT w.id INTO v_worker FROM public.workers w
   WHERE w.nome = 'Brandon' AND w.parent_admin_id = v_admin;
  IF v_worker IS NULL THEN
    RAISE EXCEPTION 'Reparo cancelado: trabalhador Brandon não encontrado na empresa BrasilCred.';
  END IF;

  SELECT count(*) INTO v_count FROM public.daily_cash dc
   WHERE dc.cash_date = DATE '2026-09-15'
     AND dc.admin_id = v_admin AND dc.worker_id = v_worker;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Reparo cancelado: esperava exatamente 1 caixa de 2026-09-15 para Brandon/BrasilCred, encontrado %.', v_count;
  END IF;

  SELECT dc.id, dc.status, round(COALESCE(dc.opening_balance,0),2)
    INTO v_dc_id, v_status, v_opening
    FROM public.daily_cash dc
   WHERE dc.cash_date = DATE '2026-09-15'
     AND dc.admin_id = v_admin AND dc.worker_id = v_worker
   FOR UPDATE;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'Reparo cancelado: o caixa de 2026-09-15 está com status "%", esperado "open".', v_status;
  END IF;
  IF round(v_opening,2) <> 9350.00 THEN
    RAISE EXCEPTION 'Reparo cancelado: caixa inicial é R$ %, esperado R$ 9350,00.', to_char(v_opening,'FM999999990.00');
  END IF;

  SELECT round(COALESCE(SUM(m.amount),0),2) INTO v_day_net
    FROM public.cash_movements m
   WHERE m.cash_date = DATE '2026-09-15'
     AND m.admin_id IS NOT DISTINCT FROM v_admin
     AND m.worker_id IS NOT DISTINCT FROM v_worker
     AND NOT (m.reversed_at IS NOT NULL AND m.reversal_movement_id IS NULL
              AND m.reverses_movement_id IS NULL);
  IF round(v_day_net,2) <> 0.00 THEN
    RAISE EXCEPTION 'Reparo cancelado: movimento líquido do dia é R$ %, esperado R$ 0,00.', to_char(v_day_net,'FM999999990.00');
  END IF;

  SELECT cb.id, round(COALESCE(cb.ledger_base_amount,0),2), round(COALESCE(cb.available_cash,0),2)
    INTO v_cb_id, v_base_old, v_avail_old
    FROM public.cash_balance cb
   WHERE cb.admin_id IS NOT DISTINCT FROM v_admin
     AND cb.worker_id IS NOT DISTINCT FROM v_worker
   FOR UPDATE;

  IF v_cb_id IS NULL THEN
    RAISE EXCEPTION 'Reparo cancelado: não existe saldo de caixa para Brandon/BrasilCred.';
  END IF;
  IF v_avail_old <> 0.00 THEN
    RAISE EXCEPTION 'Reparo cancelado: Caixa Disponível atual é R$ %, esperado R$ 0,00.', to_char(v_avail_old,'FM999999990.00');
  END IF;

  v_ledger_net := public._cash_ledger_net(v_admin, v_worker);
  v_expected   := round(v_opening + v_day_net, 2);

  IF round(v_expected - v_avail_old, 2) <> 9350.00 THEN
    RAISE EXCEPTION 'Reparo cancelado: diferença apurada R$ %, esperada R$ 9350,00.',
      to_char(round(v_expected - v_avail_old,2),'FM999999990.00');
  END IF;

  v_new_base := round(v_expected - v_ledger_net, 2);

  INSERT INTO public.audit_logs (action_type, entity_type, entity_id, old_value, new_value, observation, worker_id, admin_id, user_role, metadata)
  VALUES (
    'correcao_saldo_base', 'cash_balance', v_cb_id,
    jsonb_build_object('ledger_base_amount', v_base_old, 'available_cash', v_avail_old),
    jsonb_build_object('ledger_base_amount', v_new_base, 'available_cash', v_expected),
    'Correção do Caixa Disponível do caixa aberto de 2026-09-15 (Brandon/BrasilCred) sem criar movimentações.',
    v_worker, v_admin, 'system',
    jsonb_build_object('cash_date','2026-09-15','daily_cash_id',v_dc_id,'opening_balance',v_opening,
                       'day_net',v_day_net,'ledger_net',v_ledger_net,'expected_available',v_expected)
  );

  UPDATE public.cash_balance
     SET ledger_base_amount = v_new_base,
         updated_at = now()
   WHERE id = v_cb_id;

  SELECT round(COALESCE(available_cash,0),2) INTO v_avail_new FROM public.cash_balance WHERE id = v_cb_id;
  IF v_avail_new <> 9350.00 THEN
    RAISE EXCEPTION 'Reparo cancelado: após a correção o Caixa Disponível ficou R$ %, esperado R$ 9350,00.',
      to_char(v_avail_new,'FM999999990.00');
  END IF;
END $$;

-- 2) PROTEÇÃO PERMANENTE

-- 2.1 Bloqueia alteração direta de saldo-base / escopo por usuários do app
CREATE OR REPLACE FUNCTION public.cash_balance_guard_manual_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_has_open boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_user IN ('authenticated','anon') THEN
      IF round(COALESCE(NEW.ledger_base_amount,0),2) IS DISTINCT FROM round(COALESCE(OLD.ledger_base_amount,0),2) THEN
        RAISE EXCEPTION 'Alteração do saldo-base do caixa não é permitida pelo aplicativo. A operação foi cancelada.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.admin_id IS DISTINCT FROM OLD.admin_id THEN
        RAISE EXCEPTION 'Alteração da empresa ou do trabalhador do saldo de caixa não é permitida. A operação foi cancelada.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.daily_cash dc
     WHERE dc.status = 'open'
       AND dc.admin_id IS NOT DISTINCT FROM OLD.admin_id
       AND dc.worker_id IS NOT DISTINCT FROM OLD.worker_id
  ) INTO v_has_open;
  IF v_has_open THEN
    RAISE EXCEPTION 'Não é possível excluir o saldo de caixa enquanto existir caixa aberto neste escopo.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_cash_balance_guard_manual_changes ON public.cash_balance;
CREATE TRIGGER trg_cash_balance_guard_manual_changes
BEFORE UPDATE OR DELETE ON public.cash_balance
FOR EACH ROW EXECUTE FUNCTION public.cash_balance_guard_manual_changes();

-- 2.2 Consistência do caixa aberto após movimentações (validada no fim da transação)
CREATE OR REPLACE FUNCTION public._assert_open_cash_consistency(p_admin uuid, p_worker uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_date    date;
  v_opening numeric;
  v_day     numeric;
  v_avail   numeric;
  v_diff    numeric;
BEGIN
  SELECT dc.cash_date, round(COALESCE(dc.opening_balance,0),2)
    INTO v_date, v_opening
    FROM public.daily_cash dc
   WHERE dc.status = 'open'
     AND dc.admin_id IS NOT DISTINCT FROM p_admin
     AND dc.worker_id IS NOT DISTINCT FROM p_worker
   ORDER BY dc.cash_date DESC
   LIMIT 1;

  IF v_date IS NULL THEN RETURN; END IF;

  SELECT round(COALESCE(SUM(m.amount),0),2) INTO v_day
    FROM public.cash_movements m
   WHERE m.cash_date = v_date
     AND m.admin_id IS NOT DISTINCT FROM p_admin
     AND m.worker_id IS NOT DISTINCT FROM p_worker
     AND NOT (m.reversed_at IS NOT NULL AND m.reversal_movement_id IS NULL
              AND m.reverses_movement_id IS NULL);

  SELECT round(COALESCE(available_cash,0),2) INTO v_avail
    FROM public.cash_balance
   WHERE admin_id IS NOT DISTINCT FROM p_admin
     AND worker_id IS NOT DISTINCT FROM p_worker;

  IF v_avail IS NULL THEN
    RAISE EXCEPTION 'Operação cancelada: não existe saldo de caixa para esta empresa e trabalhador.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_diff := round(v_opening + v_day - v_avail, 2);
  IF abs(v_diff) > 0.01 THEN
    RAISE EXCEPTION 'Operação cancelada por inconsistência do caixa de %: caixa inicial R$ %, movimento líquido R$ %, caixa esperado R$ %, caixa disponível R$ %, diferença R$ %.',
      to_char(v_date, 'DD/MM/YYYY'),
      to_char(v_opening, 'FM999999990.00'),
      to_char(v_day, 'FM999999990.00'),
      to_char(round(v_opening + v_day, 2), 'FM999999990.00'),
      to_char(v_avail, 'FM999999990.00'),
      to_char(v_diff, 'FM999999990.00')
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.cash_movements_assert_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    PERFORM public._assert_open_cash_consistency(OLD.admin_id, OLD.worker_id);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    IF TG_OP = 'INSERT'
       OR NEW.admin_id IS DISTINCT FROM OLD.admin_id
       OR NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
      PERFORM public._assert_open_cash_consistency(NEW.admin_id, NEW.worker_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_cash_movements_assert_consistency ON public.cash_movements;
CREATE CONSTRAINT TRIGGER trg_cash_movements_assert_consistency
AFTER INSERT OR UPDATE OR DELETE ON public.cash_movements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.cash_movements_assert_consistency();