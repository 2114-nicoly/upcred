
-- 1. Add opened_at / opened_by to daily_cash
ALTER TABLE public.daily_cash
  ADD COLUMN IF NOT EXISTS opened_at  timestamptz,
  ADD COLUMN IF NOT EXISTS opened_by  uuid;

-- 2. Helper: is there an OPEN daily_cash for this scope/date?
CREATE OR REPLACE FUNCTION public._cash_is_open_for(p_cash_date date, p_worker_id uuid, p_admin_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.daily_cash dc
    WHERE dc.cash_date = p_cash_date
      AND dc.status = 'open'
      AND (
        (p_worker_id IS NOT NULL AND dc.worker_id = p_worker_id)
        OR (p_worker_id IS NULL AND dc.worker_id IS NULL AND dc.admin_id IS NOT DISTINCT FROM p_admin_id)
      )
  );
$$;

-- 3. RPC: explicit opening of the day's cash. Idempotent (returns existing row id).
CREATE OR REPLACE FUNCTION public.open_daily_cash(p_cash_date date)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid;
  v_admin  uuid;
  v_id uuid;
  v_status text;
  v_opening numeric := 0;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

  IF v_worker IS NULL AND v_admin IS NULL THEN
    RAISE EXCEPTION 'usuário sem escopo (worker/admin) para abrir caixa';
  END IF;

  IF v_worker IS NOT NULL THEN
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id = v_worker LIMIT 1;
  ELSE
    SELECT id, status INTO v_id, v_status FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id = v_admin LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    IF v_status = 'closed' THEN
      RAISE EXCEPTION 'caixa deste dia já foi fechado; reabra antes de operar';
    END IF;
    RETURN v_id; -- already open
  END IF;

  -- opening_balance = expected_closing_balance of last closed daily_cash in same scope
  SELECT COALESCE(counted_closing_balance, expected_closing_balance, 0)
    INTO v_opening
   FROM public.daily_cash
  WHERE cash_date < p_cash_date
    AND status = 'closed'
    AND (CASE WHEN v_worker IS NOT NULL THEN worker_id = v_worker
              ELSE worker_id IS NULL AND admin_id = v_admin END)
  ORDER BY cash_date DESC LIMIT 1;
  v_opening := COALESCE(v_opening, 0);

  INSERT INTO public.daily_cash (
    cash_date, worker_id, admin_id, status,
    opening_balance, opened_at, opened_by, user_id
  ) VALUES (
    p_cash_date, v_worker, v_admin, 'open',
    v_opening, now(), auth.uid(), auth.uid()
  ) RETURNING id INTO v_id;

  -- audit event in ledger (non-financial, bypasses cash-lock guard)
  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation,
    origin, user_id, worker_id, admin_id
  ) VALUES (
    p_cash_date, 'caixa_aberto', 0, 0, 'Caixa aberto',
    'caixa', auth.uid(), v_worker, v_admin
  );

  PERFORM public.log_audit('reabrir_caixa','cash',v_id,NULL,
    jsonb_build_object('cash_date',p_cash_date,'opening_balance',v_opening,'action','open'),
    'Abertura do caixa', v_worker);
  RETURN v_id;
END;
$$;

-- 4. Update guards: also block when there is NO open daily_cash for the scope/date.
-- Whitelist of "operational" event types that require an OPEN cash.
CREATE OR REPLACE FUNCTION public.cash_lock_guard_daily_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date; v_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker := OLD.worker_id; v_admin := OLD.admin_id; v_date := OLD.cash_date; v_type := OLD.event_type;
  ELSE
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.cash_date, CURRENT_DATE);
    v_type   := NEW.event_type;
  END IF;
  IF v_type IN ('pagamento','recebimento_multa','emprestimo_novo','renovacao','renegociacao','entrada_manual','saida_manual','quitacao','ajuste_manual','nao_pagou','estorno_pagamento','estorno_manual') THEN
    IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP <> 'DELETE' AND NOT public._cash_is_open_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) ainda não foi aberto. Abra o caixa antes de registrar esta operação.', v_date
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_cash_movements()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker := OLD.worker_id; v_admin := OLD.admin_id; v_date := OLD.cash_date;
  ELSE
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.cash_date, CURRENT_DATE);
  END IF;
  IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT public._cash_is_open_for(v_date, v_worker, v_admin) THEN
    RAISE EXCEPTION 'Caixa do dia (%) ainda não foi aberto. Abra o caixa antes de registrar esta operação.', v_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_not_paid_marks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_worker := OLD.worker_id; v_admin := OLD.admin_id; v_date := OLD.mark_date;
  ELSE
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.mark_date, CURRENT_DATE);
  END IF;
  IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
    RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de registrar esta operação.', v_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT public._cash_is_open_for(v_date, v_worker, v_admin) THEN
    RAISE EXCEPTION 'Caixa do dia (%) ainda não foi aberto. Abra o caixa antes de registrar esta operação.', v_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION public.cash_lock_guard_loans()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_worker uuid; v_admin uuid; v_date date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_worker := COALESCE(NEW.worker_id, public.get_worker_id(auth.uid()));
    v_admin  := COALESCE(NEW.admin_id, public.get_admin_id(auth.uid()));
    v_date   := COALESCE(NEW.loan_date, CURRENT_DATE);
    IF public._cash_is_closed_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) está fechado. Reabra o caixa antes de criar este empréstimo.', v_date
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT public._cash_is_open_for(v_date, v_worker, v_admin) THEN
      RAISE EXCEPTION 'Caixa do dia (%) ainda não foi aberto. Abra o caixa antes de criar este empréstimo.', v_date
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 5. Update close_daily_cash_v2 to require existing OPEN row and log caixa_fechado event
CREATE OR REPLACE FUNCTION public.close_daily_cash_v2(p_cash_date date, p_counted numeric, p_note text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_worker uuid; v_admin uuid;
  v_id uuid; v_status text;
  v_opening numeric := 0;
  v_received numeric := 0; v_penalty numeric := 0; v_lent numeric := 0;
  v_manual_in numeric := 0; v_manual_out numeric := 0;
  v_in numeric := 0; v_out numeric := 0;
  v_not_paid int := 0; v_events int := 0;
  v_expected numeric := 0; v_diff numeric := 0;
BEGIN
  v_worker := public.get_worker_id(auth.uid());
  v_admin  := public.get_admin_id(auth.uid());

  IF v_worker IS NOT NULL THEN
    SELECT id, status, opening_balance INTO v_id, v_status, v_opening FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id = v_worker LIMIT 1;
  ELSIF v_admin IS NOT NULL THEN
    SELECT id, status, opening_balance INTO v_id, v_status, v_opening FROM public.daily_cash
      WHERE cash_date = p_cash_date AND worker_id IS NULL AND admin_id = v_admin LIMIT 1;
  ELSE
    RAISE EXCEPTION 'usuário sem escopo (worker/admin) para fechar caixa';
  END IF;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'caixa deste dia ainda não foi aberto';
  END IF;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'caixa já está fechado';
  END IF;

  v_opening := COALESCE(v_opening, 0);

  WITH ev AS (
    SELECT * FROM public.daily_events
     WHERE cash_date = p_cash_date
       AND reversed_at IS NULL
       AND (CASE WHEN v_worker IS NOT NULL THEN worker_id = v_worker
                 ELSE worker_id IS NULL AND admin_id = v_admin END)
  )
  SELECT
    COALESCE(SUM(CASE WHEN event_type='pagamento' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='recebimento_multa' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type IN ('emprestimo_novo','renovacao','renegociacao') THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='entrada_manual' THEN amount_in ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN event_type='saida_manual' THEN amount_out ELSE 0 END),0),
    COALESCE(SUM(amount_in),0),
    COALESCE(SUM(amount_out),0),
    COALESCE(SUM(CASE WHEN event_type='nao_pagou' THEN 1 ELSE 0 END),0)::int,
    COUNT(*)::int
  INTO v_received, v_penalty, v_lent, v_manual_in, v_manual_out, v_in, v_out, v_not_paid, v_events
  FROM ev;

  v_expected := v_opening + v_in - v_out;
  v_diff := COALESCE(p_counted, v_expected) - v_expected;

  IF ABS(v_diff) > 0.01 AND (p_note IS NULL OR length(trim(p_note)) < 3) THEN
    RAISE EXCEPTION 'observação obrigatória quando há diferença entre valor contado e esperado';
  END IF;

  -- log caixa_fechado event BEFORE flipping status (non-financial, but safer)
  INSERT INTO public.daily_events (
    cash_date, event_type, amount_in, amount_out, observation,
    origin, user_id, worker_id, admin_id
  ) VALUES (
    p_cash_date, 'caixa_fechado', 0, 0,
    'Caixa fechado' || CASE WHEN p_note IS NOT NULL AND length(trim(p_note)) > 0 THEN ' — ' || p_note ELSE '' END,
    'caixa', auth.uid(), v_worker, v_admin
  );

  UPDATE public.daily_cash SET
    status='closed',
    total_in=v_in, total_out=v_out,
    total_received=v_received, total_penalty_received=v_penalty,
    total_lent=v_lent,
    total_manual_in=v_manual_in, total_manual_out=v_manual_out,
    total_not_paid_count=v_not_paid,
    total_items_treated=v_events,
    total_events_count=v_events,
    expected_closing_balance=v_expected,
    counted_closing_balance=p_counted,
    closing_difference=v_diff,
    closing_note=p_note,
    closed_at=now(), closed_by=auth.uid()
  WHERE id=v_id;

  PERFORM public.log_audit('fechar_caixa','cash',v_id,NULL,
    jsonb_build_object('cash_date',p_cash_date,'expected',v_expected,'counted',p_counted,'diff',v_diff,'events',v_events),
    p_note, v_worker);
  RETURN v_id;
END;
$$;
