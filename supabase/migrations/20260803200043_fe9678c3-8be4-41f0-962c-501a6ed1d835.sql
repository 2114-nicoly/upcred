-- 1) Guards: nomes padronizados, idempotente, sem duplicar execução
DROP TRIGGER IF EXISTS trg_cash_lock_daily_events ON public.daily_events;
DROP TRIGGER IF EXISTS trg_cash_lock_cash_movements ON public.cash_movements;
DROP TRIGGER IF EXISTS trg_cash_lock_not_paid_marks ON public.not_paid_marks;
DROP TRIGGER IF EXISTS trg_cash_lock_loans ON public.loans;

DROP TRIGGER IF EXISTS cash_lock_guard_daily_events ON public.daily_events;
DROP TRIGGER IF EXISTS cash_lock_guard_cash_movements ON public.cash_movements;
DROP TRIGGER IF EXISTS cash_lock_guard_not_paid_marks ON public.not_paid_marks;
DROP TRIGGER IF EXISTS cash_lock_guard_loans ON public.loans;

CREATE TRIGGER cash_lock_guard_daily_events
  BEFORE INSERT OR UPDATE OR DELETE ON public.daily_events
  FOR EACH ROW EXECUTE FUNCTION public.cash_lock_guard_daily_events();

CREATE TRIGGER cash_lock_guard_cash_movements
  BEFORE INSERT OR UPDATE OR DELETE ON public.cash_movements
  FOR EACH ROW EXECUTE FUNCTION public.cash_lock_guard_cash_movements();

CREATE TRIGGER cash_lock_guard_not_paid_marks
  BEFORE INSERT OR UPDATE OR DELETE ON public.not_paid_marks
  FOR EACH ROW EXECUTE FUNCTION public.cash_lock_guard_not_paid_marks();

CREATE TRIGGER cash_lock_guard_loans
  BEFORE INSERT OR UPDATE ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.cash_lock_guard_loans();

-- 2) Proteção contra dois caixas abertos: advisory lock + UPDATE de status/worker/admin
CREATE OR REPLACE FUNCTION public.daily_cash_single_open_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_other date;
BEGIN
  IF NEW.status <> 'open' THEN RETURN NEW; END IF;
  IF NEW.admin_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'open'
     AND OLD.admin_id IS NOT DISTINCT FROM NEW.admin_id
     AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.admin_id::text || ':' || COALESCE(NEW.worker_id::text, '-'), 0)
  );

  SELECT dc.cash_date INTO v_other
    FROM public.daily_cash dc
   WHERE dc.status = 'open'
     AND dc.id <> NEW.id
     AND dc.admin_id = NEW.admin_id
     AND dc.worker_id IS NOT DISTINCT FROM NEW.worker_id
   ORDER BY dc.cash_date ASC
   LIMIT 1;

  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Existe um caixa aberto em %. Finalize esse caixa antes de abrir outro.',
      to_char(v_other, 'DD/MM/YYYY') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS daily_cash_single_open_guard_trg ON public.daily_cash;
CREATE TRIGGER daily_cash_single_open_guard_trg
  BEFORE INSERT OR UPDATE OF status, worker_id, admin_id ON public.daily_cash
  FOR EACH ROW EXECUTE FUNCTION public.daily_cash_single_open_guard();

-- 3) Fechar acesso direto às funções internas
REVOKE ALL ON FUNCTION public._scope_open_cash(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._scope_open_cash(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public._assert_active_cash_date(date, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._assert_active_cash_date(date, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.daily_cash_single_open_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_lock_guard_daily_events() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_lock_guard_cash_movements() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_lock_guard_not_paid_marks() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_lock_guard_loans() FROM PUBLIC, anon, authenticated;

-- get_active_daily_cash permanece acessível
GRANT EXECUTE ON FUNCTION public.get_active_daily_cash(uuid) TO authenticated, service_role;

-- 4) Confirmar que o automático continua desligado (somente remoção de jobs, nenhum caixa alterado)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job
     WHERE jobname IN ('auto-close-daily-cash')
        OR command ILIKE '%auto_close_previous_day%'
        OR command ILIKE '%auto_close_cash_maintenance%'
        OR command ILIKE '%reconcile_legacy_open_cash%';
  END IF;
END $$;