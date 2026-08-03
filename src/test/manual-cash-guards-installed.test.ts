import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Correção do caixa manual: os guards precisam estar realmente instalados
 * como triggers e as funções internas fechadas para authenticated/anon.
 */

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const FIX = (() => {
  const files = readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
  return readFileSync(resolve(MIG_DIR, files[files.length - 1]), "utf8").replace(/\s+/g, " ");
})();

describe("triggers dos guards criados", () => {
  const cases: Array<[string, string, string]> = [
    ["cash_lock_guard_daily_events", "public.daily_events", "BEFORE INSERT OR UPDATE OR DELETE"],
    ["cash_lock_guard_cash_movements", "public.cash_movements", "BEFORE INSERT OR UPDATE OR DELETE"],
    ["cash_lock_guard_not_paid_marks", "public.not_paid_marks", "BEFORE INSERT OR UPDATE OR DELETE"],
    ["cash_lock_guard_loans", "public.loans", "BEFORE INSERT OR UPDATE"],
  ];

  for (const [name, table, timing] of cases) {
    it(`instala ${name} em ${table}`, () => {
      expect(FIX).toContain(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);
      expect(FIX).toContain(
        `CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${name}();`,
      );
    });
  }

  it("remove os triggers antigos para não executar duas vezes", () => {
    for (const old of [
      "trg_cash_lock_daily_events ON public.daily_events",
      "trg_cash_lock_cash_movements ON public.cash_movements",
      "trg_cash_lock_not_paid_marks ON public.not_paid_marks",
      "trg_cash_lock_loans ON public.loans",
    ]) {
      expect(FIX).toContain(`DROP TRIGGER IF EXISTS ${old};`);
    }
  });

  it("não altera dados existentes", () => {
    expect(FIX).not.toContain("UPDATE public.daily_cash");
    expect(FIX).not.toContain("INSERT INTO public.daily_cash");
    expect(FIX).not.toContain("DELETE FROM public.daily_cash");
  });
});

describe("proteção contra dois caixas abertos", () => {
  it("usa advisory lock por admin + worker", () => {
    expect(FIX).toContain(
      "PERFORM pg_advisory_xact_lock( hashtextextended(NEW.admin_id::text || ':' || COALESCE(NEW.worker_id::text, '-'), 0) );",
    );
  });

  it("dispara também em mudança de worker_id e admin_id", () => {
    expect(FIX).toContain(
      "CREATE TRIGGER daily_cash_single_open_guard_trg BEFORE INSERT OR UPDATE OF status, worker_id, admin_id ON public.daily_cash",
    );
    expect(FIX).toContain(
      "IF TG_OP = 'UPDATE' AND OLD.status = 'open' AND OLD.admin_id IS NOT DISTINCT FROM NEW.admin_id AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id THEN RETURN NEW; END IF;",
    );
  });
});

describe("funções internas fechadas", () => {
  const internos = [
    "public._scope_open_cash(uuid, uuid)",
    "public._assert_active_cash_date(date, uuid, uuid)",
    "public.daily_cash_single_open_guard()",
    "public.cash_lock_guard_daily_events()",
    "public.cash_lock_guard_cash_movements()",
    "public.cash_lock_guard_not_paid_marks()",
    "public.cash_lock_guard_loans()",
  ];

  for (const fn of internos) {
    it(`revoga acesso direto a ${fn}`, () => {
      expect(FIX).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated;`);
    });
  }

  it("mantém get_active_daily_cash para authenticated", () => {
    expect(FIX).toContain(
      "GRANT EXECUTE ON FUNCTION public.get_active_daily_cash(uuid) TO authenticated, service_role;",
    );
  });
});

describe("fechamento automático continua desligado", () => {
  it("remove qualquer job de cron automático e não cria novos", () => {
    expect(FIX).toContain("PERFORM cron.unschedule(jobid) FROM cron.job");
    expect(FIX).toContain("jobname IN ('auto-close-daily-cash')");
    expect(FIX).toContain("command ILIKE '%auto_close_previous_day%'");
    expect(FIX).toContain("command ILIKE '%auto_close_cash_maintenance%'");
    expect(FIX).toContain("command ILIKE '%reconcile_legacy_open_cash%'");
    expect(FIX).not.toContain("cron.schedule(");
  });
});
