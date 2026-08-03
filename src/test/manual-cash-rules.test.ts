import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regra definitiva: nada de fechamento automático e somente UM caixa aberto
 * por escopo (admin_id + worker_id).
 */

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const LATEST = (() => {
  const files = readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
  const file = files[files.length - 1];
  return readFileSync(resolve(MIG_DIR, file), "utf8").replace(/\s+/g, " ");
})();

describe("fechamento automático desativado", () => {
  it("remove todos os jobs de cron de fechamento automático", () => {
    expect(LATEST).toContain("PERFORM cron.unschedule(jobid) FROM cron.job");
    expect(LATEST).toContain("jobname IN ('auto-close-daily-cash')");
    expect(LATEST).toContain("command ILIKE '%auto_close_previous_day%'");
    expect(LATEST).toContain("command ILIKE '%auto_close_cash_maintenance%'");
    expect(LATEST).toContain("command ILIKE '%reconcile_legacy_open_cash%'");
    expect(LATEST).not.toContain("cron.schedule(");
  });

  it("as funções automáticas ficam inativas e não tocam em daily_cash", () => {
    const start = LATEST.indexOf("FUNCTION public.auto_close_previous_day()");
    const end = LATEST.indexOf("REVOKE ALL ON FUNCTION public.auto_close_previous_day()");
    const block = LATEST.slice(start, end);
    expect((block.match(/jsonb_build_object\('disabled', true\)/g) || []).length).toBe(2);
    expect(block).not.toContain("UPDATE public.daily_cash");
    expect(block).not.toContain("INSERT INTO public.daily_cash");
    expect(block).not.toContain("_close_daily_cash_core");
  });

  it("a abertura não chama fechamento automático nem reconciliação legacy", () => {
    const start = LATEST.indexOf("FUNCTION public.open_daily_cash(");
    const end = LATEST.indexOf("-- 7) Reabertura");
    const body = LATEST.slice(start, end);
    expect(body).not.toContain("_legacy_close_daily_cash");
    expect(body).not.toContain("_ensure_daily_cash_closed_strict");
    expect(body).not.toContain("auto_close_cash_maintenance");
    expect(body).not.toContain("_scope_pending_cash_dates");
    expect(body).not.toContain("_record_auto_close_failure");
  });
});

describe("somente um caixa aberto por escopo", () => {
  it("localiza o caixa aberto mais antigo por admin_id + worker_id", () => {
    expect(LATEST).toContain("FUNCTION public._scope_open_cash(p_worker uuid, p_admin uuid)");
    expect(LATEST).toContain("WHERE dc.status = 'open' AND dc.admin_id = p_admin AND dc.worker_id IS NOT DISTINCT FROM p_worker ORDER BY dc.cash_date ASC LIMIT 1");
  });

  it("tem proteção central no banco contra dois caixas abertos", () => {
    expect(LATEST).toContain("FUNCTION public.daily_cash_single_open_guard()");
    expect(LATEST).toContain("CREATE TRIGGER daily_cash_single_open_guard_trg BEFORE INSERT OR UPDATE OF status ON public.daily_cash");
    expect(LATEST).toContain("Existe um caixa aberto em %. Finalize esse caixa antes de abrir outro.");
    expect(LATEST).not.toContain("CREATE UNIQUE INDEX");
  });

  it("usa advisory lock por empresa + trabalhador ao abrir e reabrir", () => {
    const locks = LATEST.match(
      /PERFORM pg_advisory_xact_lock\( hashtextextended\((v_admin|dc\.admin_id)::text \|\| ':' \|\| COALESCE\((v_worker|dc\.worker_id)::text, '-'\), 0\) \)/g,
    ) || [];
    expect(locks.length).toBe(2);
  });

  it("caixa aberto na mesma data é retornado; em outra data recusa a abertura", () => {
    expect(LATEST).toContain("IF v_open.cash_date = p_cash_date THEN RETURN v_open.id; END IF;");
    expect(LATEST).toContain("RAISE EXCEPTION 'Existe um caixa aberto em %. Finalize esse caixa antes de abrir outro.', to_char(v_open.cash_date, 'DD/MM/YYYY');");
  });

  it("mantém as regras de data: novo caixa só hoje, futuro bloqueado", () => {
    expect(LATEST).toContain("Não é permitido abrir caixa em data futura. Abra o caixa na própria data.");
    expect(LATEST).toContain("Não é permitido abrir um caixa antigo. Utilize o processo de solicitação de reabertura.");
  });

  it("reabertura é bloqueada quando existe outro caixa aberto no escopo", () => {
    const start = LATEST.indexOf("FUNCTION public._reopen_daily_cash_core(");
    const end = LATEST.indexOf("-- 8) Fechamento manual");
    const body = LATEST.slice(start, end);
    expect(body).toContain("SELECT * INTO v_open FROM public._scope_open_cash(dc.worker_id, dc.admin_id);");
    expect(body).toContain("Existe um caixa aberto em %. Finalize esse caixa antes de abrir outro.");
  });
});

describe("get_active_daily_cash", () => {
  it("retorna os campos exigidos", () => {
    expect(LATEST).toContain(
      "FUNCTION public.get_active_daily_cash(p_worker_id uuid DEFAULT NULL::uuid) RETURNS TABLE (id uuid, cash_date date, status text, worker_id uuid, admin_id uuid, opening_balance numeric)",
    );
  });

  it("valida escopo do trabalhador e da empresa", () => {
    expect(LATEST).toContain("IF p_worker_id IS DISTINCT FROM public.get_worker_id(auth.uid()) THEN RAISE EXCEPTION 'caixa fora do seu escopo';");
    expect(LATEST).toContain("IF NOT v_is_super AND v_target_admin IS DISTINCT FROM v_caller_admin THEN RAISE EXCEPTION 'trabalhador não pertence à sua equipe';");
    expect(LATEST).toContain("GRANT EXECUTE ON FUNCTION public.get_active_daily_cash(uuid) TO authenticated, service_role;");
    expect(LATEST).toContain("REVOKE ALL ON FUNCTION public.get_active_daily_cash(uuid) FROM PUBLIC, anon;");
  });
});

describe("fechamento manual preservado", () => {
  it("fecha o caixa exato do escopo com origem manual", () => {
    expect(LATEST).toContain("WHERE cash_date = p_cash_date AND worker_id IS NOT DISTINCT FROM v_worker AND admin_id = v_admin");
    expect(LATEST).toContain("RETURN public._close_daily_cash_core(v_id, p_counted, p_note, 'manual', auth.uid());");
    expect(LATEST).not.toContain("'automatic_opened'");
    expect(LATEST).not.toContain("'automatic_not_opened'");
  });
});

describe("operações só na data do caixa aberto", () => {
  it("cria a validação compartilhada", () => {
    expect(LATEST).toContain("FUNCTION public._assert_active_cash_date(p_cash_date date, p_worker uuid, p_admin uuid)");
    expect(LATEST).toContain("O caixa aberto é o de %. Registre a operação nessa data ou finalize o caixa.");
  });

  it("aplica em eventos, movimentos, não pagos e empréstimos", () => {
    for (const guard of [
      "cash_lock_guard_daily_events",
      "cash_lock_guard_cash_movements",
      "cash_lock_guard_not_paid_marks",
      "cash_lock_guard_loans",
    ]) {
      const start = LATEST.indexOf(`FUNCTION public.${guard}()`);
      expect(start).toBeGreaterThan(-1);
      expect(LATEST.slice(start, start + 2000)).toContain("PERFORM public._assert_active_cash_date(");
    }
  });

  it("cobre despesas e estornos na lista de eventos financeiros", () => {
    expect(LATEST).toContain("'estorno_pagamento','estorno_manual','despesa'");
  });
});
