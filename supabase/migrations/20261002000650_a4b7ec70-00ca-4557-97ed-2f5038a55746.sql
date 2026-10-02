CREATE OR REPLACE FUNCTION public.register_route_batch_payments_tx(p_cash_date date, p_installment_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_count int;
  v_rec record;
  v_amount numeric;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_worker uuid;
  v_admin uuid;
  v_first boolean := true;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'access denied: usuário não autenticado'; END IF;
  IF p_cash_date IS NULL THEN RAISE EXCEPTION 'Data do caixa obrigatória'; END IF;
  IF p_installment_ids IS NULL OR cardinality(p_installment_ids) = 0 THEN
    RAISE EXCEPTION 'Nenhuma parcela selecionada';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_installment_ids) x WHERE x IS NULL) THEN
    RAISE EXCEPTION 'Lista contém parcela inválida';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_installment_ids) x;
  IF cardinality(v_ids) <> cardinality(p_installment_ids) THEN
    RAISE EXCEPTION 'Lista contém parcelas duplicadas';
  END IF;

  SELECT count(*) INTO v_count FROM public.installments WHERE id = ANY(v_ids);
  IF v_count <> cardinality(v_ids) THEN RAISE EXCEPTION 'Uma ou mais parcelas não foram encontradas'; END IF;

  -- Bloqueio determinístico: empréstimos e parcelas ordenados por id.
  PERFORM 1 FROM public.loans l
   WHERE l.id IN (SELECT loan_id FROM public.installments WHERE id = ANY(v_ids))
   ORDER BY l.id FOR UPDATE;
  PERFORM 1 FROM public.installments WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;

  IF EXISTS (SELECT loan_id FROM public.installments WHERE id = ANY(v_ids) GROUP BY loan_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Mais de uma parcela do mesmo empréstimo no lote';
  END IF;
  IF EXISTS (SELECT l.client_id FROM public.installments i JOIN public.loans l ON l.id = i.loan_id
              WHERE i.id = ANY(v_ids) GROUP BY l.client_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Mais de uma parcela do mesmo cliente no lote';
  END IF;

  FOR v_rec IN
    SELECT i.id AS inst_id, i.number, i.amount AS inst_amount, i.paid_amount, i.status AS inst_status,
           COALESCE(i.is_penalty,false) AS is_penalty,
           l.id AS loan_id, l.client_id, l.status AS loan_status, l.remaining_balance,
           l.worker_id, l.admin_id, c.name AS client_name
      FROM public.installments i
      JOIN public.loans l ON l.id = i.loan_id
      LEFT JOIN public.clients c ON c.id = l.client_id
     WHERE i.id = ANY(v_ids)
     ORDER BY i.id
  LOOP
    IF v_rec.is_penalty THEN
      RAISE EXCEPTION 'Parcela % (%) é multa e não pode entrar no lote', v_rec.number, COALESCE(v_rec.client_name,'?');
    END IF;
    IF v_rec.inst_status NOT IN ('pending','partial','overdue') THEN
      RAISE EXCEPTION 'Parcela % de % não está pendente (status %)', v_rec.number, COALESCE(v_rec.client_name,'?'), v_rec.inst_status;
    END IF;
    IF v_rec.loan_status NOT IN ('active','overdue') THEN
      RAISE EXCEPTION 'Empréstimo de % não está ativo (status %)', COALESCE(v_rec.client_name,'?'), v_rec.loan_status;
    END IF;
    IF COALESCE(v_rec.remaining_balance,0) <= 0.01 THEN
      RAISE EXCEPTION 'Empréstimo de % não tem saldo a receber', COALESCE(v_rec.client_name,'?');
    END IF;
    IF v_rec.worker_id IS NULL OR v_rec.admin_id IS NULL THEN
      RAISE EXCEPTION 'Empréstimo de % sem trabalhador/empresa definidos', COALESCE(v_rec.client_name,'?');
    END IF;
    IF v_first THEN
      v_worker := v_rec.worker_id; v_admin := v_rec.admin_id; v_first := false;
    ELSIF v_rec.worker_id <> v_worker OR v_rec.admin_id <> v_admin THEN
      RAISE EXCEPTION 'O lote mistura trabalhadores ou empresas diferentes';
    END IF;
  END LOOP;

  -- Caixa aberto exatamente no escopo e data.
  PERFORM 1 FROM public.daily_cash
   WHERE worker_id = v_worker AND admin_id = v_admin AND cash_date = p_cash_date AND status = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não há caixa aberto em % para este trabalhador', to_char(p_cash_date,'DD/MM/YYYY');
  END IF;

  FOR v_rec IN
    SELECT i.id AS inst_id, i.amount AS inst_amount, l.id AS loan_id, l.client_id, c.name AS client_name
      FROM public.installments i
      JOIN public.loans l ON l.id = i.loan_id
      LEFT JOIN public.clients c ON c.id = l.client_id
     WHERE i.id = ANY(v_ids)
     ORDER BY i.id
  LOOP
    SELECT LEAST(v_rec.inst_amount, remaining_balance) INTO v_amount FROM public.loans WHERE id = v_rec.loan_id;
    v_amount := round(v_amount, 2);
    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Valor inválido para %', COALESCE(v_rec.client_name,'?');
    END IF;
    v_res := public.register_payment_tx(v_rec.loan_id, v_amount, v_rec.client_id, p_cash_date,
                                        'rota_lote', v_rec.inst_id, 'Pagamento em lote — 1 parcela');
    v_total := v_total + v_amount;
    v_results := v_results || jsonb_build_object(
      'installment_id', v_rec.inst_id, 'loan_id', v_rec.loan_id, 'client_id', v_rec.client_id,
      'client_name', v_rec.client_name, 'amount', v_amount, 'result', v_res);
  END LOOP;

  RETURN jsonb_build_object('count', jsonb_array_length(v_results), 'total', round(v_total,2), 'results', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.register_route_batch_payments_tx(date, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.register_route_batch_payments_tx(date, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_route_batch_payments_tx(date, uuid[]) TO service_role;