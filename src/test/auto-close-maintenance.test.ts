import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  getCloseOriginLabel,
  isAutomaticClose,
  isLegacyIncompleteClose,
  normalizeCloseOrigin,
} from "@/lib/close-origin";

/**
 * Fechamento automático: saneamento único dos caixas antigos + manutenção
 * permanente no servidor, sem depender de ninguém entrar no aplicativo.
 */

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const SQL = (() => {
  const files = readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
  return files
    .map(f => readFileSync(resolve(MIG_DIR, f), "utf8"))
    .filter(sql => sql.includes("auto_close_cash_maintenance"))
    .join("\n")
    .replace(/\s+/g, " ");
})();

describe("saneamento único dos caixas antigos", () => {
  it("processa em lotes somente caixas abertos anteriores a ontem", () => {
    expect(SQL).toContain("FUNCTION public.reconcile_legacy_open_cash(p_limit integer DEFAULT 200)");
    expect(SQL).toContain("WHERE dc.status = 'open' AND dc.cash_date < (v_today - 1) AND dc.admin_id IS NOT NULL");
    expect(SQL).toContain("LIMIT GREATEST(COALESCE(p_limit, 200), 1)");
  });

  it("é restrito ao service_role", () => {
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.reconcile_legacy_open_cash(integer) FROM PUBLIC, anon, authenticated");
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.reconcile_legacy_open_cash(integer) TO service_role");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public._legacy_close_daily_cash(uuid) FROM PUBLIC, anon, authenticated");
  });

  it("preserva o escopo exato e valida o vínculo do trabalhador com a empresa", () => {
    expect(SQL).toContain("IF v_worker_admin IS NULL OR v_worker_admin IS DISTINCT FROM v_admin THEN");
    expect(SQL).toContain("PERFORM pg_advisory_xact_lock( hashtextextended(v_admin::text || ':' || COALESCE(v_worker::text,'-') || ':' || v_date::text, 0) )");
  });

  it("nunca reprocessa nem sobrescreve snapshot existente", () => {
    expect(SQL).toContain("IF dc.status = 'closed' OR EXISTS (SELECT 1 FROM public.daily_cash_snapshots s WHERE s.daily_cash_id = dc.id) THEN");
    expect(SQL).toContain("'already_closed', true");
  });

  it("usa somente dados imutáveis da data, sem inventar contagem", () => {
    expect(SQL).toContain("'events', v_events_json");
    expect(SQL).toContain("'cash_movements', v_mov_json");
    expect(SQL).toContain("'not_paid_marks', v_np_json");
    expect(SQL).toContain("counted_closing_balance = NULL");
    expect(SQL).toContain("closing_difference = NULL");
    const fn = SQL.slice(SQL.indexOf("FUNCTION public._legacy_close_daily_cash"));
    const body = fn.slice(0, fn.indexOf("REVOKE ALL ON FUNCTION public._legacy_close_daily_cash"));
    expect(body).not.toContain("UPDATE public.cash_balance");
    expect(body).not.toContain("UPDATE public.installments");
    expect(body).not.toContain("UPDATE public.loans");
    expect(body).not.toContain("build_daily_cash_snapshot_v2");
  });

  it("marca o payload como histórico incompleto", () => {
    expect(SQL).toContain("'historical_complete', false");
    expect(SQL).toContain("'snapshot_kind', 'legacy_incomplete'");
    expect(SQL).toContain("'warning', 'Este fechamento antigo não possui histórico congelado completo'");
    expect(SQL).toContain("close_origin = 'legacy_auto_reconciliation'");
  });

  it("a nova origem é aceita pela restrição da tabela", () => {
    expect(SQL).toContain("'legacy_auto_reconciliation'::text");
  });
});

describe("rotina permanente auto_close_cash_maintenance", () => {
  it("usa America/Sao_Paulo e nunca processa hoje ou futuro", () => {
    expect(SQL).toContain("v_yesterday date := ((now() AT TIME ZONE 'America/Sao_Paulo')::date) - 1");
    const fn = SQL.slice(SQL.indexOf("FUNCTION public.auto_close_cash_maintenance()"));
    const body = fn.slice(0, fn.indexOf("REVOKE ALL ON FUNCTION public.auto_close_cash_maintenance()"));
    expect(body).toContain("dc.cash_date < v_yesterday");
    expect(body).toContain("dc.cash_date = v_yesterday AND dc.status = 'open'");
    expect(body).not.toContain("cash_date = v_today");
    expect(body).not.toContain("v_today + 1");
  });

  it("fecha ontem pela rotina completa com snapshot", () => {
    expect(SQL).toContain("res := public._ensure_previous_daily_cash_closed(v_yesterday, r.worker_id, r.admin_id)");
  });

  it("cria e fecha o caixa de quem não abriu, sem datas anteriores ao trabalhador", () => {
    expect(SQL).toContain("(w.created_at AT TIME ZONE 'America/Sao_Paulo')::date <= v_yesterday");
    expect(SQL).toContain("WHERE w.active = true AND w.archived_at IS NULL AND w.parent_admin_id IS NOT NULL");
    expect(SQL).toContain("cac.admin_id = w.parent_admin_id AND cac.manual_status = 'paused'");
  });

  it("processa cada trabalhador separadamente e continua após falha", () => {
    const fn = SQL.slice(SQL.indexOf("FUNCTION public.auto_close_cash_maintenance()"));
    const body = fn.slice(0, fn.indexOf("REVOKE ALL ON FUNCTION public.auto_close_cash_maintenance()"));
    expect((body.match(/EXCEPTION WHEN OTHERS THEN v_failed := v_failed \+ 1;/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("PERFORM public._record_auto_close_failure(");
  });

  it("escopo explícito por empresa e trabalhador", () => {
    expect(SQL).toContain("dc.worker_id = w.id AND dc.admin_id = w.parent_admin_id");
    expect(SQL).toContain("JOIN public.admins a ON a.id = w.parent_admin_id AND a.active = true");
  });

  it("registra monitoramento em auto_close_settings", () => {
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS last_run_at timestamptz");
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS last_success_at timestamptz");
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS last_closed_count integer");
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS last_failed_count integer");
    expect(SQL).toContain("UPDATE public.auto_close_settings SET last_run_at = now()");
  });
});

describe("falhas e novas tentativas", () => {
  it("guarda tentativa, próxima tentativa e resolução", () => {
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS resolved_at timestamptz");
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS next_retry_at timestamptz");
    expect(SQL).toContain("attempt_count = attempt_count + 1");
    expect(SQL).toContain("next_retry_at = now() + interval '5 minutes'");
    expect(SQL).toContain("resolved_at = NULL");
  });

  it("resolve somente quando fechamento e snapshot existem juntos", () => {
    expect(SQL).toContain("AND dc.status = 'closed' AND EXISTS (SELECT 1 FROM public.daily_cash_snapshots s WHERE s.daily_cash_id = dc.id)");
    expect(SQL).toContain("SET resolved_at = now()");
  });

  it("continua tentando mesmo depois que a data deixa de ser ontem", () => {
    expect(SQL).toContain("WHERE f.resolved_at IS NULL AND f.cash_date < v_today");
  });
});

describe("abertura do caixa de hoje", () => {
  it("verifica qualquer caixa anterior aberto do mesmo escopo", () => {
    expect(SQL).toContain("FUNCTION public._scope_oldest_open_cash_date(p_worker uuid, p_admin uuid, p_before date)");
    expect(SQL).toContain("SELECT MIN(dc.cash_date) FROM public.daily_cash dc WHERE dc.status = 'open' AND dc.cash_date < p_before AND dc.admin_id = p_admin AND dc.worker_id IS NOT DISTINCT FROM p_worker");
    expect(SQL).toContain("v_pending := public._scope_oldest_open_cash_date(v_worker, v_admin, v_today)");
  });

  it("bloqueia informando data e motivo", () => {
    expect(SQL).toContain("O caixa de % ainda está aberto e não pôde ser finalizado automaticamente. O caixa de hoje não foi aberto. Motivo: %");
  });

  it("continua proibindo caixa passado ou futuro", () => {
    expect(SQL).toContain("Não é permitido abrir caixa em data futura. Abra o caixa na própria data.");
    expect(SQL).toContain("Não é permitido abrir um caixa antigo. Utilize o processo de solicitação de reabertura.");
  });
});

describe("cron único", () => {
  it("mantém somente auto-close-daily-cash a cada 5 minutos", () => {
    expect(SQL).toContain("PERFORM cron.schedule('auto-close-daily-cash', '*/5 * * * *', 'SELECT public.auto_close_cash_maintenance();')");
    expect(SQL).toContain("OR command ILIKE '%auto_close_previous_day%'");
    expect(SQL).toContain("IF (SELECT count(*) FROM cron.job WHERE jobname = 'auto-close-daily-cash') <> 1 THEN");
    expect(SQL).toContain("AND active) THEN");
  });

  it("roda sem usuário logado (service_role, sem auth.uid nas rotinas)", () => {
    const fn = SQL.slice(SQL.indexOf("FUNCTION public.auto_close_cash_maintenance()"));
    const body = fn.slice(0, fn.indexOf("REVOKE ALL ON FUNCTION public.auto_close_cash_maintenance()"));
    expect(body).not.toContain("auth.uid()");
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.auto_close_cash_maintenance() TO service_role");
  });
});

describe("interface do fechamento legado", () => {
  it("mostra o rótulo de histórico antigo incompleto", () => {
    expect(getCloseOriginLabel("legacy_auto_reconciliation")).toBe(
      "Fechado automaticamente — histórico antigo incompleto",
    );
    expect(normalizeCloseOrigin("legacy_auto_reconciliation")).toBe("legacy_auto_reconciliation");
    expect(isAutomaticClose("legacy_auto_reconciliation")).toBe(true);
    expect(isLegacyIncompleteClose("legacy_auto_reconciliation")).toBe(true);
    expect(isLegacyIncompleteClose("automatic_opened")).toBe(false);
    expect(isLegacyIncompleteClose(null)).toBe(false);
  });
});
