import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Blindagem do fechamento automático: só fecha o dia imediatamente anterior,
 * nunca reconstrói dias antes da implantação, serializa com advisory lock e
 * bloqueia a abertura de hoje enquanto ontem não estiver congelado.
 */

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const SQL = (() => {
  const files = readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
  const withFn = files
    .map(f => readFileSync(resolve(MIG_DIR, f), "utf8"))
    .filter(sql => sql.includes("_ensure_previous_daily_cash_closed"));
  return withFn.join("\n").replace(/\s+/g, " ");
})();

describe("implantação não reconstrói dias antigos", () => {
  it("cria configuração com enabled_from_date igual à data de São Paulo", () => {
    expect(SQL).toContain("CREATE TABLE IF NOT EXISTS public.auto_close_settings");
    expect(SQL).toContain("SELECT true, (now() AT TIME ZONE 'America/Sao_Paulo')::date");
  });

  it("a rotina ignora datas anteriores à ativação", () => {
    expect(SQL).toContain("IF v_from IS NULL OR p_date < v_from THEN");
    expect(SQL).toContain("'before_enabled_from'");
  });

  it("o cron também respeita a data de ativação", () => {
    expect(SQL).toContain("IF v_from IS NULL OR v_day < v_from THEN");
  });
});

describe("_ensure_previous_daily_cash_closed", () => {
  it("aceita somente o dia imediatamente anterior", () => {
    expect(SQL).toContain("IF p_date IS DISTINCT FROM (v_today - 1) THEN");
    expect(SQL).toContain("Somente o dia imediatamente anterior pode ser finalizado automaticamente.");
  });

  it("serializa cron e abertura com advisory lock por empresa, trabalhador e data", () => {
    expect(SQL).toContain("PERFORM pg_advisory_xact_lock(");
    expect(SQL).toContain("p_admin_id::text || ':' || COALESCE(p_worker_id::text,'-') || ':' || p_date::text");
  });

  it("é idempotente quando o caixa já está fechado", () => {
    expect(SQL).toContain("IF v_id IS NOT NULL AND v_status = 'closed' THEN");
    expect(SQL).toContain("'already_closed', true");
  });

  it("usa o cash_balance exato do mesmo trabalhador e empresa, sem assumir zero", () => {
    expect(SQL).toContain("WHERE cb.worker_id = p_worker_id AND cb.admin_id = p_admin_id");
    expect(SQL).toContain("IF v_opening IS NULL THEN");
    expect(SQL).toContain("Saldo do trabalhador não encontrado. O fechamento automático foi cancelado.");
  });

  it("nunca processa trabalhador de outra empresa", () => {
    expect(SQL).toContain("IF v_worker_admin IS NULL OR v_worker_admin IS DISTINCT FROM p_admin_id THEN");
    expect(SQL).toContain("Trabalhador não pertence a esta empresa. O fechamento foi cancelado.");
  });

  it("exige snapshot do mesmo daily_cash", () => {
    expect(SQL).toContain("FROM public.daily_cash_snapshots s WHERE s.daily_cash_id = v_id");
    expect(SQL).toContain("O fechamento não gerou o registro histórico obrigatório. O caixa continua aberto.");
  });

  it("usa as origens corretas conforme o caixa existia ou não", () => {
    expect(SQL).toContain("v_origin := 'automatic_not_opened'");
    expect(SQL).toContain("v_origin := 'automatic_opened'");
  });

  it("é interna: sem EXECUTE para authenticated", () => {
    expect(SQL).toContain(
      "REVOKE ALL ON FUNCTION public._ensure_previous_daily_cash_closed(date, uuid, uuid) FROM PUBLIC, anon, authenticated",
    );
    expect(SQL).toContain(
      "GRANT EXECUTE ON FUNCTION public._ensure_previous_daily_cash_closed(date, uuid, uuid) TO service_role",
    );
  });
});

describe("hoje não abre enquanto ontem não estiver congelado", () => {
  it("open_daily_cash chama a rotina antes de criar o caixa de hoje", () => {
    expect(SQL).toContain("PERFORM public._ensure_previous_daily_cash_closed(v_today - 1, v_worker, v_admin)");
    const ensureIdx = SQL.indexOf("_ensure_previous_daily_cash_closed(v_today - 1");
    const insertIdx = SQL.indexOf("INSERT INTO public.daily_cash ( cash_date, worker_id, admin_id, status, opening_balance, opened_at");
    expect(ensureIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(ensureIdx);
  });

  it("falha no fechamento ou snapshot de ontem impede a abertura de hoje", () => {
    expect(SQL).toContain("Não foi possível finalizar o caixa anterior. O caixa de hoje não foi aberto.");
  });
});

describe("cron reutiliza a rotina única", () => {
  it("não duplica cálculos nem chama _close_daily_cash_core diretamente", () => {
    const fn = SQL.slice(SQL.indexOf("FUNCTION public.auto_close_previous_day()"));
    const body = fn.slice(0, fn.indexOf("REVOKE ALL ON FUNCTION public.auto_close_previous_day()"));
    expect(body).toContain("public._ensure_previous_daily_cash_closed(v_day, r.worker_id, r.admin_id)");
    expect(body).not.toContain("_close_daily_cash_core");
  });

  it("processa somente ontem", () => {
    expect(SQL).toContain("v_day := ((now() AT TIME ZONE 'America/Sao_Paulo')::date) - 1");
  });

  it("falha de um trabalhador não interrompe os demais", () => {
    expect(SQL).toContain("EXCEPTION WHEN OTHERS THEN v_failed := v_failed + 1");
  });
});

describe("fechamento manual x automático", () => {
  it("manual com diferença acima de R$ 0,01 exige observação de 3+ caracteres", () => {
    expect(SQL).toContain("IF abs(v_diff) > 0.01 AND (p_note IS NULL OR length(trim(p_note)) < 3) THEN");
    expect(SQL).toContain("Escreva uma observação com pelo menos 3 caracteres.");
  });

  it("rejeita valor contado negativo", () => {
    expect(SQL).toContain("IF v_counted < 0 THEN");
    expect(SQL).toContain("O valor contado não pode ser negativo.");
  });

  it("automático usa o esperado e diferença zero", () => {
    expect(SQL).toContain("IF v_auto THEN v_counted := v_expected; v_diff := 0;");
  });

  it("nenhum fechamento altera cash_balance", () => {
    const fn = SQL.slice(SQL.indexOf("FUNCTION public._close_daily_cash_core"));
    const body = fn.slice(0, fn.indexOf("REVOKE ALL ON FUNCTION public._close_daily_cash_core"));
    expect(body).not.toContain("UPDATE public.cash_balance");
  });
});

describe("auto_close_failures", () => {
  it("trabalhador não lê falhas da empresa", () => {
    expect(SQL).toContain("public.has_role(auth.uid(), 'admin'::app_role) AND public.get_worker_id(auth.uid()) IS NULL");
    expect(SQL).toContain("public.is_super_admin(auth.uid())");
  });

  it("não repete a mesma falha: atualiza contador de tentativas", () => {
    expect(SQL).toContain("SET attempt_count = attempt_count + 1");
    expect(SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS auto_close_failures_scope_worker_uidx");
    expect(SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS auto_close_failures_scope_admin_uidx");
  });

  it("o cron grava falhas pela rotina de deduplicação", () => {
    expect(SQL).toContain("PERFORM public._record_auto_close_failure(v_day, r.worker_id, r.admin_id, NULL, SQLERRM)");
  });
});
