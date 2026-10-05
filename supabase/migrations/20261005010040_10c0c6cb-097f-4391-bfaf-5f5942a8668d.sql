CREATE OR REPLACE FUNCTION public._assert_open_cash_consistency(p_admin uuid, p_worker uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_avail numeric; v_base numeric; v_net numeric; v_diff numeric; v_found boolean := false;
BEGIN
  -- Conferência de ATOMICIDADE (não cronológica): o saldo corrente deve ser
  -- exatamente saldo-base + soma líquida do ledger, ou seja, cada movimento
  -- aplicado uma única vez. Não reconstrói abertura + dia + posteriores; essa
  -- conferência histórica permanece em _closing_basis/_assert_closing_consistency.
  SELECT true, round(COALESCE(cb.available_cash,0),2), COALESCE(cb.ledger_base_amount,0)
    INTO v_found, v_avail, v_base
    FROM public.cash_balance cb
   WHERE cb.admin_id IS NOT DISTINCT FROM p_admin
     AND cb.worker_id IS NOT DISTINCT FROM p_worker
   LIMIT 1;

  IF NOT COALESCE(v_found,false) THEN
    RAISE EXCEPTION 'Operação cancelada: não existe saldo de caixa para esta empresa e trabalhador.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_net := public._cash_ledger_net(p_admin, p_worker);
  v_diff := round(v_avail - round(v_base + v_net, 2), 2);
  IF abs(v_diff) <= 0.01 THEN RETURN; END IF;

  RAISE EXCEPTION 'Operação cancelada: o Caixa Disponível (R$ %) não corresponde ao saldo-base + movimentos registrados (R$ %). Diferença R$ %.',
    to_char(v_avail, 'FM999999990.00'),
    to_char(round(v_base + v_net, 2), 'FM999999990.00'),
    to_char(v_diff, 'FM999999990.00')
    USING ERRCODE = 'check_violation';
END $function$;