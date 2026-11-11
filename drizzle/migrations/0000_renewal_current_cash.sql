DO $migration$
DECLARE body text; original text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='renew_loan_tx';
 IF body IS NULL THEN RAISE EXCEPTION 'renew_loan_tx not found'; END IF;
 original := body;
 body := replace(body,'  v_cb_id uuid;', '  v_cb_id uuid;
  v_available numeric;
  v_cash_after numeric;');
 body := replace(body, '  SELECT id INTO v_cb_id FROM public.cash_balance
   WHERE admin_id = v_old.admin_id AND worker_id = v_old.worker_id FOR UPDATE;
  IF v_cb_id IS NULL THEN
    INSERT INTO public.cash_balance (worker_id, admin_id, available_cash, money_lent, interest_receivable, penalty_receivable, ledger_base_amount)
    VALUES (v_old.worker_id, v_old.admin_id, 0, 0, 0, 0, 0) RETURNING id INTO v_cb_id;
  END IF;', '  SELECT id, round(available_cash, 2) INTO v_cb_id, v_available FROM public.cash_balance
   WHERE admin_id = v_old.admin_id AND worker_id = v_old.worker_id FOR UPDATE;
  IF v_cb_id IS NULL OR v_available IS NULL THEN
    RAISE EXCEPTION ''Caixa Disponível indisponível para o trabalhador deste contrato. A renovação foi cancelada.'';
  END IF;
  PERFORM public._assert_open_cash_consistency(v_old.admin_id, v_old.worker_id);');
 body := replace(body,'  v_released := GREATEST(0, round(p_amount - v_absorbed, 2));', '  v_released := GREATEST(0, round(p_amount - v_absorbed, 2));
  v_cash_after := round(v_available + v_paid - v_released, 2);
  IF v_cash_after < -0.004 THEN
    RAISE EXCEPTION ''Saldo insuficiente no caixa. Caixa disponível atual: R$ %. Valor líquido da operação: R$ %. Faltam: R$ %.'',
      to_char(v_available, ''FM999999990.00''), to_char(GREATEST(0, v_released - v_paid), ''FM999999990.00''), to_char(abs(v_cash_after), ''FM999999990.00'')
      USING ERRCODE = ''check_violation'',
        DETAIL = jsonb_build_object(''code'', ''CASH_INSUFFICIENT'', ''available_cash'', v_available,
          ''operation_amount'', GREATEST(0, v_released - v_paid), ''missing_amount'', abs(v_cash_after))::text,
        HINT = ''CASH_INSUFFICIENT'';
  END IF;
  -- Derive cash once at the existing final balance update, after both movements.
  SET CONSTRAINTS public.trg_cash_movements_sync_balance DEFERRED;');
 body := replace(body,'  SELECT status, remaining_balance INTO v_chk', '  PERFORM public._assert_open_cash_consistency(v_old.admin_id, v_old.worker_id);
  IF (SELECT round(available_cash, 2) FROM public.cash_balance WHERE id = v_cb_id) IS DISTINCT FROM v_cash_after THEN
    RAISE EXCEPTION ''Divergência contábil na renovação: o Caixa Disponível final não corresponde ao saldo atual + pagamento recebido - dinheiro liberado. A operação foi cancelada.'' USING ERRCODE = ''check_violation'';
  END IF;

  SELECT status, remaining_balance INTO v_chk');
 IF body=original OR position('SELECT id, round(available_cash, 2)' in body)=0 OR position('v_available + v_paid - v_released' in body)=0 OR position('Divergência contábil na renovação' in body)=0 THEN RAISE EXCEPTION 'Unexpected renew_loan_tx definition'; END IF;
 EXECUTE body;
 SELECT pg_get_functiondef(p.oid) INTO body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='cash_movements_sync_balance';
 original := body;
 body := replace(body,'  UPDATE public.cash_balance SET updated_at = now() WHERE id = v_id;', '  -- Preserve every guard; skip only an identical balance already derived by renewal.
  UPDATE public.cash_balance SET updated_at = now()
   WHERE id = v_id AND round(available_cash, 2) IS DISTINCT FROM v_after;');
 IF body IS NULL OR body=original THEN RAISE EXCEPTION 'Unexpected cash_movements_sync_balance definition'; END IF;
 EXECUTE body;
END $migration$;