-- =========================================================
-- 1. PADRONIZAÇÃO MONETÁRIA
-- =========================================================
ALTER TABLE public.cash_movements
  ALTER COLUMN amount TYPE numeric(14,2) USING round(COALESCE(amount, 0), 2);

ALTER TABLE public.cash_balance
  ALTER COLUMN available_cash TYPE numeric(14,2) USING round(COALESCE(available_cash, 0), 2);

ALTER TABLE public.cash_balance
  ADD COLUMN IF NOT EXISTS ledger_base_amount numeric(14,2) NOT NULL DEFAULT 0;

-- =========================================================
-- 2. UNICIDADE POR EMPRESA + TRABALHADOR
-- =========================================================
DROP INDEX IF EXISTS public.uniq_cash_balance_worker;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cash_balance_admin_worker
  ON public.cash_balance (admin_id, worker_id) NULLS NOT DISTINCT;

-- =========================================================
-- 3. SOMA LÍQUIDA OFICIAL DO LEDGER
-- Estornos legados (marcados sem contrapartida) são ignorados.
-- =========================================================
CREATE OR REPLACE FUNCTION public._cash_ledger_net(p_admin uuid, p_worker uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT round(COALESCE(SUM(m.amount), 0), 2)
    FROM public.cash_movements m
   WHERE m.admin_id IS NOT DISTINCT FROM p_admin
     AND m.worker_id IS NOT DISTINCT FROM p_worker
     AND NOT (m.reversed_at IS NOT NULL
              AND m.reversal_movement_id IS NULL
              AND m.reverses_movement_id IS NULL);
$$;

REVOKE ALL ON FUNCTION public._cash_ledger_net(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- =========================================================
-- 4. PRESERVAÇÃO DO SALDO-BASE + RECONCILIAÇÃO AUDITÁVEL
-- =========================================================
-- 4.1 preserva exatamente o saldo atual
UPDATE public.cash_balance cb
   SET ledger_base_amount = round(COALESCE(cb.available_cash, 0)
                                  - public._cash_ledger_net(cb.admin_id, cb.worker_id), 2);

-- 4.2 resíduos: |saldo| < 0,005 vira zero
UPDATE public.cash_balance cb
   SET ledger_base_amount = round(-public._cash_ledger_net(cb.admin_id, cb.worker_id), 2),
       available_cash = 0
 WHERE abs(COALESCE(cb.available_cash, 0)) < 0.005;

-- 4.3 Brandon / UpCred: último saldo confiável = fechamento contado de 08/08/2026
--     (R$ 2.007,68, conferido fisicamente, diferença zero) e nenhuma movimentação posterior.
INSERT INTO public.audit_logs (user_role, worker_id, admin_id, action_type, entity_type, entity_id,
                               old_value, new_value, observation)
SELECT 'system', cb.worker_id, cb.admin_id, 'ajuste_reconciliacao', 'cash_balance', cb.id,
       jsonb_build_object('available_cash', cb.available_cash,
                          'ledger_net', public._cash_ledger_net(cb.admin_id, cb.worker_id)),
       jsonb_build_object('available_cash', 2007.68,
                          'ledger_base_amount',
                          round(2007.68 - public._cash_ledger_net(cb.admin_id, cb.worker_id), 2),
                          'source', 'fechamento contado de 2026-08-08 (diferença zero)'),
       'Reconciliação do Caixa Disponível: saldo-base ajustado ao último fechamento contado confiável.'
  FROM public.cash_balance cb
 WHERE cb.worker_id = 'b6675057-2588-4eac-a3b0-057d6c86270a'
   AND cb.admin_id  = 'a57f91d4-906a-4dc1-8f4c-54135b818e1a';

UPDATE public.cash_balance cb
   SET ledger_base_amount = round(2007.68 - public._cash_ledger_net(cb.admin_id, cb.worker_id), 2),
       available_cash = 2007.68
 WHERE cb.worker_id = 'b6675057-2588-4eac-a3b0-057d6c86270a'
   AND cb.admin_id  = 'a57f91d4-906a-4dc1-8f4c-54135b818e1a';

-- 4.4 saldos negativos reais restantes: ajuste de reconciliação auditável até zero
INSERT INTO public.audit_logs (user_role, worker_id, admin_id, action_type, entity_type, entity_id,
                               old_value, new_value, observation)
SELECT 'system', cb.worker_id, cb.admin_id, 'ajuste_reconciliacao', 'cash_balance', cb.id,
       jsonb_build_object('available_cash', cb.available_cash,
                          'ledger_net', public._cash_ledger_net(cb.admin_id, cb.worker_id)),
       jsonb_build_object('available_cash', 0,
                          'ledger_base_amount',
                          round(-public._cash_ledger_net(cb.admin_id, cb.worker_id), 2),
                          'adjustment', round(-cb.available_cash, 2)),
       'Reconciliação do Caixa Disponível: saldo negativo histórico levado a zero via saldo-base auditável.'
  FROM public.cash_balance cb
 WHERE cb.available_cash < 0;

UPDATE public.cash_balance cb
   SET ledger_base_amount = round(-public._cash_ledger_net(cb.admin_id, cb.worker_id), 2),
       available_cash = 0
 WHERE cb.available_cash < 0;

-- 4.5 fórmula oficial aplicada a todas as linhas
UPDATE public.cash_balance cb
   SET available_cash = round(cb.ledger_base_amount
                              + public._cash_ledger_net(cb.admin_id, cb.worker_id), 2);

-- =========================================================
-- 5. CAIXA DISPONÍVEL DERIVADO (nenhuma tela grava direto)
-- =========================================================
CREATE OR REPLACE FUNCTION public.cash_balance_derive_available()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new numeric;
BEGIN
  v_new := round(COALESCE(NEW.ledger_base_amount, 0)
                 + public._cash_ledger_net(NEW.admin_id, NEW.worker_id), 2);
  IF v_new < 0 AND v_new > -0.005 THEN
    v_new := 0;
  END IF;
  NEW.available_cash := v_new;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cash_balance_derive_available ON public.cash_balance;
CREATE TRIGGER trg_cash_balance_derive_available
BEFORE INSERT OR UPDATE ON public.cash_balance
FOR EACH ROW EXECUTE FUNCTION public.cash_balance_derive_available();

-- =========================================================
-- 6. SINCRONIZAÇÃO E BLOQUEIO DE SALDO INSUFICIENTE
-- =========================================================
CREATE OR REPLACE FUNCTION public.cash_movements_sync_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin   uuid;
  v_worker  uuid;
  v_base    numeric;
  v_net     numeric;
  v_after   numeric;
  v_before  numeric;
  v_amount  numeric := 0;
  v_id      uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_admin := OLD.admin_id; v_worker := OLD.worker_id;
  ELSE
    v_admin := NEW.admin_id; v_worker := NEW.worker_id;
    v_amount := COALESCE(NEW.amount, 0) - COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.amount END, 0);
  END IF;

  SELECT id, COALESCE(ledger_base_amount, 0) INTO v_id, v_base
    FROM public.cash_balance
   WHERE admin_id IS NOT DISTINCT FROM v_admin
     AND worker_id IS NOT DISTINCT FROM v_worker
   FOR UPDATE;

  IF v_id IS NULL THEN
    INSERT INTO public.cash_balance (worker_id, admin_id, available_cash, money_lent,
                                     interest_receivable, penalty_receivable, ledger_base_amount)
    VALUES (v_worker, v_admin, 0, 0, 0, 0, 0)
    RETURNING id, COALESCE(ledger_base_amount, 0) INTO v_id, v_base;
  END IF;

  v_net    := public._cash_ledger_net(v_admin, v_worker);
  v_after  := round(v_base + v_net, 2);
  v_before := round(v_after - v_amount, 2);

  IF v_after < -0.004 THEN
    RAISE EXCEPTION 'Saldo insuficiente no caixa. Caixa disponível atual: R$ %. Valor da operação: R$ %. Faltam: R$ %. Adicione dinheiro ao Caixa Disponível para continuar.',
      to_char(v_before, 'FM999999990.00'),
      to_char(abs(v_amount), 'FM999999990.00'),
      to_char(abs(v_after), 'FM999999990.00')
      USING ERRCODE = 'check_violation',
            DETAIL = jsonb_build_object(
              'code', 'CASH_INSUFFICIENT',
              'available_cash', v_before,
              'operation_amount', v_amount,
              'missing_amount', round(abs(v_after), 2)
            )::text,
            HINT = 'CASH_INSUFFICIENT';
  END IF;

  UPDATE public.cash_balance SET updated_at = now() WHERE id = v_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_cash_movements_sync_balance ON public.cash_movements;
CREATE CONSTRAINT TRIGGER trg_cash_movements_sync_balance
AFTER INSERT OR UPDATE OR DELETE ON public.cash_movements
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION public.cash_movements_sync_balance();

-- =========================================================
-- 7. FUNÇÃO TRANSACIONAL ÚNICA
-- =========================================================
CREATE OR REPLACE FUNCTION public._apply_cash_movement_tx(
  p_type          text,
  p_amount        numeric,          -- valor JÁ COM SINAL
  p_cash_date     date,
  p_event_type    text,
  p_observation   text DEFAULT NULL,
  p_client_id     uuid DEFAULT NULL,
  p_loan_id       uuid DEFAULT NULL,
  p_installment_id uuid DEFAULT NULL,
  p_origin        text DEFAULT 'geral',
  p_metadata      jsonb DEFAULT '{}'::jsonb,
  p_reverses_movement_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_worker uuid;
  v_admin  uuid;
  v_delta  numeric;
  v_before numeric;
  v_after  numeric;
  v_cb     public.cash_balance%ROWTYPE;
  v_dc     record;
  v_mov_id uuid;
  v_ev_id  uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_cash_date IS NULL THEN RAISE EXCEPTION 'Data do caixa não informada.'; END IF;
  IF p_amount IS NULL THEN RAISE EXCEPTION 'Informe um valor válido.'; END IF;

  v_delta  := round(p_amount, 2);
  v_worker := public.get_worker_id(v_uid);
  v_admin  := public.get_admin_id(v_uid);
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa deste usuário. A operação foi cancelada.';
  END IF;

  SELECT * INTO v_dc
    FROM public.daily_cash
   WHERE cash_date = p_cash_date
     AND worker_id IS NOT DISTINCT FROM v_worker
     AND admin_id = v_admin
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caixa do dia (%) ainda não foi aberto.', p_cash_date;
  END IF;
  IF v_dc.status <> 'open' THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar a movimentação.', p_cash_date;
  END IF;

  SELECT * INTO v_cb
    FROM public.cash_balance
   WHERE admin_id = v_admin
     AND worker_id IS NOT DISTINCT FROM v_worker
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.cash_balance (worker_id, admin_id, available_cash, money_lent,
                                     interest_receivable, penalty_receivable, ledger_base_amount)
    VALUES (v_worker, v_admin, 0, 0, 0, 0, 0)
    RETURNING * INTO v_cb;
  END IF;

  v_before := round(COALESCE(v_cb.ledger_base_amount, 0)
                    + public._cash_ledger_net(v_admin, v_worker), 2);
  v_after  := round(v_before + v_delta, 2);

  INSERT INTO public.cash_movements (
    type, amount, client_id, loan_id, installment_id, observation, cash_date,
    user_id, worker_id, admin_id, reverses_movement_id
  ) VALUES (
    p_type, v_delta, p_client_id, p_loan_id, p_installment_id, p_observation, p_cash_date,
    v_uid, v_worker, v_admin, p_reverses_movement_id
  ) RETURNING id INTO v_mov_id;

  INSERT INTO public.daily_events (
    cash_date, event_type, client_id, loan_id, installment_id,
    amount_in, amount_out, observation, origin, cash_movement_id,
    metadata, user_id, worker_id, admin_id
  ) VALUES (
    p_cash_date, p_event_type, p_client_id, p_loan_id, p_installment_id,
    CASE WHEN v_delta > 0 THEN v_delta ELSE 0 END,
    CASE WHEN v_delta < 0 THEN abs(v_delta) ELSE 0 END,
    p_observation, COALESCE(p_origin, 'geral'), v_mov_id,
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object('cash_before', v_before, 'cash_after', v_after, 'delta', v_delta),
    v_uid, v_worker, v_admin
  ) RETURNING id INTO v_ev_id;

  UPDATE public.cash_movements SET daily_event_id = v_ev_id WHERE id = v_mov_id;

  -- saldo é derivado: uma única atualização
  UPDATE public.cash_balance SET updated_at = now() WHERE id = v_cb.id;

  RETURN jsonb_build_object(
    'movement_id', v_mov_id,
    'event_id', v_ev_id,
    'daily_event_id', v_ev_id,
    'delta', v_delta,
    'cash_before', v_before,
    'cash_after', v_after,
    'worker_id', v_worker,
    'admin_id', v_admin
  );
END;
$$;

REVOKE ALL ON FUNCTION public._apply_cash_movement_tx(text, numeric, date, text, text, uuid, uuid, uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;

-- =========================================================
-- 8. MOVIMENTAÇÃO MANUAL E DESPESA VIA TRANSAÇÃO ÚNICA
-- =========================================================
CREATE OR REPLACE FUNCTION public.register_manual_movement(
  p_cash_date date, p_type text, p_amount numeric,
  p_observation text DEFAULT NULL::text, p_category text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_worker uuid;
  v_admin  uuid;
  v_before numeric;
  v_delta  numeric;
  v_obs    text;
  v_res    jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_type NOT IN ('entrada_manual','saida_manual','ajuste_manual','despesa') THEN
    RAISE EXCEPTION 'Tipo de movimentação inválido.';
  END IF;
  IF p_amount IS NULL THEN RAISE EXCEPTION 'Informe um valor válido.'; END IF;
  IF p_type <> 'ajuste_manual' AND p_amount <= 0 THEN
    RAISE EXCEPTION 'Informe um valor maior que zero.';
  END IF;

  v_worker := public.get_worker_id(v_uid);
  v_admin  := public.get_admin_id(v_uid);
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa deste usuário. A movimentação foi cancelada.';
  END IF;
  IF p_type = 'ajuste_manual' AND v_worker IS NOT NULL THEN
    RAISE EXCEPTION 'Somente o administrador pode ajustar o saldo do caixa.';
  END IF;

  SELECT round(COALESCE(ledger_base_amount, 0)
               + public._cash_ledger_net(v_admin, v_worker), 2)
    INTO v_before
    FROM public.cash_balance
   WHERE admin_id = v_admin AND worker_id IS NOT DISTINCT FROM v_worker;
  v_before := COALESCE(v_before, 0);

  v_obs := NULLIF(btrim(COALESCE(p_observation, '')), '');

  IF p_type = 'ajuste_manual' THEN
    v_delta := round(p_amount - v_before, 2);
    v_obs := COALESCE(v_obs, 'Ajuste: saldo definido para ' || to_char(p_amount, 'FM999999999.00'));
  ELSIF p_type = 'entrada_manual' THEN
    v_delta := round(p_amount, 2);
  ELSE
    v_delta := -round(p_amount, 2);
    IF p_type = 'despesa' THEN
      IF p_category IS NULL OR length(btrim(p_category)) = 0 THEN
        RAISE EXCEPTION 'Categoria da despesa é obrigatória.';
      END IF;
      IF v_obs IS NULL OR length(v_obs) < 3 THEN
        RAISE EXCEPTION 'Descrição da despesa é obrigatória (mín. 3 caracteres).';
      END IF;
      v_obs := '[' || btrim(p_category) || '] ' || v_obs;
    END IF;
  END IF;

  v_res := public._apply_cash_movement_tx(
    p_type, v_delta, p_cash_date, p_type, v_obs, NULL, NULL, NULL, 'geral',
    jsonb_build_object('requested_amount', p_amount, 'category', p_category)
  );

  PERFORM public.log_audit(
    CASE p_type
      WHEN 'entrada_manual' THEN 'aporte'
      WHEN 'saida_manual'   THEN 'retirada'
      WHEN 'ajuste_manual'  THEN 'ajuste_caixa'
      ELSE 'despesa' END,
    'cash', (v_res->>'event_id')::uuid, NULL,
    jsonb_build_object('type', p_type, 'amount', p_amount, 'delta', v_delta,
                       'cash_date', p_cash_date,
                       'movement_id', (v_res->>'movement_id')::uuid,
                       'daily_event_id', (v_res->>'event_id')::uuid,
                       'cash_before', v_res->'cash_before',
                       'cash_after', v_res->'cash_after',
                       'category', p_category),
    v_obs, v_worker
  );

  RETURN v_res;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_expense(
  p_cash_date date, p_amount numeric, p_category text, p_description text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_cash_date IS NULL THEN
    p_cash_date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  END IF;
  RETURN public.register_manual_movement(p_cash_date, 'despesa', p_amount, p_description, p_category);
END;
$$;

-- =========================================================
-- 9. NEUTRALIZA ATUALIZAÇÕES DIRETAS DE available_cash
-- (o valor é sempre derivado; a RPC legada só mexe em "a receber")
-- =========================================================
CREATE OR REPLACE FUNCTION public.update_cash_balance_atomic(
  p_available_cash numeric DEFAULT 0, p_money_lent numeric DEFAULT 0,
  p_interest_receivable numeric DEFAULT 0, p_penalty_receivable numeric DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_worker uuid;
  v_admin  uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied'; END IF;
  v_worker := public.get_worker_id(v_uid);
  v_admin  := public.get_admin_id(v_uid);
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Não foi possível validar a empresa deste usuário.';
  END IF;

  INSERT INTO public.cash_balance (worker_id, admin_id, available_cash, money_lent,
                                   interest_receivable, penalty_receivable, ledger_base_amount)
  SELECT v_worker, v_admin, 0, 0, 0, 0, 0
   WHERE NOT EXISTS (
     SELECT 1 FROM public.cash_balance
      WHERE admin_id = v_admin AND worker_id IS NOT DISTINCT FROM v_worker);

  UPDATE public.cash_balance
     SET money_lent = round(COALESCE(money_lent, 0) + COALESCE(p_money_lent, 0), 2),
         interest_receivable = round(COALESCE(interest_receivable, 0) + COALESCE(p_interest_receivable, 0), 2),
         penalty_receivable = round(COALESCE(penalty_receivable, 0) + COALESCE(p_penalty_receivable, 0), 2),
         updated_at = now()
   WHERE admin_id = v_admin AND worker_id IS NOT DISTINCT FROM v_worker;
END;
$$;

-- =========================================================
-- 10. PROTEÇÃO FINAL: BANCO NÃO ACEITA CAIXA NEGATIVO
-- =========================================================
ALTER TABLE public.cash_balance
  DROP CONSTRAINT IF EXISTS cash_balance_available_non_negative;
ALTER TABLE public.cash_balance
  ADD CONSTRAINT cash_balance_available_non_negative CHECK (available_cash >= 0);

-- =========================================================
-- 11. FECHAMENTO: VALIDAÇÃO DE CONSISTÊNCIA
-- =========================================================
CREATE OR REPLACE FUNCTION public._assert_closing_consistency(
  p_admin uuid, p_worker uuid, p_cash_date date, p_opening numeric
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day   numeric;
  v_avail numeric;
  v_diff  numeric;
BEGIN
  SELECT round(COALESCE(SUM(m.amount), 0), 2) INTO v_day
    FROM public.cash_movements m
   WHERE m.cash_date = p_cash_date
     AND m.admin_id IS NOT DISTINCT FROM p_admin
     AND m.worker_id IS NOT DISTINCT FROM p_worker
     AND NOT (m.reversed_at IS NOT NULL AND m.reversal_movement_id IS NULL
              AND m.reverses_movement_id IS NULL);

  SELECT round(COALESCE(available_cash, 0), 2) INTO v_avail
    FROM public.cash_balance
   WHERE admin_id IS NOT DISTINCT FROM p_admin
     AND worker_id IS NOT DISTINCT FROM p_worker;

  IF v_avail IS NULL THEN
    RAISE EXCEPTION 'Não existe saldo de caixa para esta empresa e trabalhador. O fechamento foi cancelado.';
  END IF;

  v_diff := round(COALESCE(p_opening, 0) + v_day - v_avail, 2);
  IF abs(v_diff) > 0.01 THEN
    RAISE EXCEPTION 'Fechamento cancelado: saldo de abertura (R$ %) + movimentos do dia (R$ %) difere do Caixa Disponível (R$ %) em R$ %. O caixa permanece aberto.',
      to_char(COALESCE(p_opening, 0), 'FM999999990.00'),
      to_char(v_day, 'FM999999990.00'),
      to_char(v_avail, 'FM999999990.00'),
      to_char(v_diff, 'FM999999990.00')
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._assert_closing_consistency(uuid, uuid, date, numeric) FROM PUBLIC, anon, authenticated;