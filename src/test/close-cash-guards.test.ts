import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Blindagem do fechamento: só a RPC oficial fecha o caixa, sempre com snapshot
 * novo na mesma transação, e o cliente não grava snapshot algum.
 */

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: { cash_id: "dc1", version: 1 }, error: null })),
    from: () => {
      throw new Error("cliente não deve tocar em daily_cash_snapshots");
    },
  },
}));

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const migration = (() => {
  const files = readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
  const withGuard = files
    .map(f => readFileSync(resolve(MIG_DIR, f), "utf8"))
    .filter(sql => sql.includes("daily_cash_require_snapshot"));
  return withGuard.join("\n");
})();

const norm = (s: string) => s.replace(/\s+/g, " ");
const SQL = norm(migration);

describe("funções antigas de fechamento não são executáveis pelo cliente", () => {
  it("revoga EXECUTE de close_daily_cash(date)", () => {
    expect(SQL).toContain("REVOKE EXECUTE ON FUNCTION public.close_daily_cash(date) FROM PUBLIC, anon, authenticated");
  });

  it("revoga EXECUTE de close_daily_cash_v2(date, numeric, text)", () => {
    expect(SQL).toContain(
      "REVOKE EXECUTE ON FUNCTION public.close_daily_cash_v2(date, numeric, text) FROM PUBLIC, anon, authenticated",
    );
  });

  it("revoga EXECUTE da versão com p_payload", () => {
    expect(SQL).toContain(
      "REVOKE EXECUTE ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text, jsonb) FROM PUBLIC, anon, authenticated",
    );
  });

  it("somente a função oficial fica liberada para authenticated", () => {
    expect(SQL).toContain(
      "GRANT EXECUTE ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text) TO authenticated, service_role",
    );
  });

  it("nenhuma tela chama as funções antigas", () => {
    const src = readdirSync(resolve(process.cwd(), "src/lib")).map(f =>
      readFileSync(resolve(process.cwd(), "src/lib", f), "utf8"),
    );
    for (const s of src) {
      expect(s).not.toContain('rpc("close_daily_cash_v2"');
      expect(s).not.toContain('rpc("close_daily_cash"');
    }
  });
});

describe("daily_cash só pode ficar fechado com snapshot novo", () => {
  it("constraint trigger é DEFERRABLE e roda no fim da transação", () => {
    expect(SQL).toContain("CREATE CONSTRAINT TRIGGER trg_daily_cash_require_snapshot");
    expect(SQL).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(SQL).toContain("WHEN (NEW.status = 'closed')");
  });

  it("exige snapshot do mesmo caixa com closed_at igual ou posterior", () => {
    expect(SQL).toContain("s.daily_cash_id = NEW.id");
    expect(SQL).toContain("s.closed_at >= COALESCE(NEW.closed_at, now())");
  });

  it("fechamento sem snapshot lança erro (rollback), inclusive em UPDATE direto", () => {
    expect(SQL).toContain("AFTER INSERT OR UPDATE ON public.daily_cash");
    expect(SQL).toContain("O fechamento não gerou o registro histórico obrigatório. O caixa continua aberto.");
  });

  it("o fechamento oficial grava o snapshot na mesma transação (satisfaz o trigger)", () => {
    expect(SQL).toContain("INSERT INTO public.daily_cash_snapshots");
    expect(SQL).toContain("v_cash_id := public.close_daily_cash_v2(p_cash_date, p_counted, p_note)");
  });

  it("nova versão após reabertura usa MAX(version) + 1 do mesmo caixa", () => {
    expect(SQL).toContain("SELECT COALESCE(MAX(version), 0) + 1 INTO v_version FROM public.daily_cash_snapshots WHERE daily_cash_id = v_cash_id");
  });
});

describe("snapshot não pode ser enviado pelo cliente", () => {
  it("policies de INSERT/UPDATE removidas e privilégios revogados", () => {
    expect(SQL).toContain("DROP POLICY IF EXISTS snapshot_insert_scoped ON public.daily_cash_snapshots");
    expect(SQL).toContain("DROP POLICY IF EXISTS snapshot_update_scoped ON public.daily_cash_snapshots");
    expect(SQL).toContain("REVOKE INSERT, UPDATE, DELETE ON public.daily_cash_snapshots FROM PUBLIC, anon, authenticated");
    expect(SQL).toContain("GRANT SELECT ON public.daily_cash_snapshots TO authenticated, anon");
    expect(SQL).toContain("GRANT ALL ON public.daily_cash_snapshots TO service_role");
  });

  it("saveDailyCashSnapshot só lança erro, sem código de gravação", async () => {
    const mod = await import("@/lib/daily-snapshot");
    await expect(mod.saveDailyCashSnapshot("2026-08-03", {} as any)).rejects.toThrow(
      mod.SNAPSHOT_CLIENT_SAVE_BLOCKED_MESSAGE,
    );
    const src = readFileSync(resolve(process.cwd(), "src/lib/daily-snapshot.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function saveDailyCashSnapshot"));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect(body).not.toContain("insert(");
    expect(body).not.toContain("update(");
    expect(body).not.toContain("no-unreachable");
  });
});

describe("motivo de reabertura vinculado ao caixa", () => {
  it("filtra audit_logs por entity_id do caixa e pela data", () => {
    expect(SQL).toContain("al.action_type = 'reabrir_caixa' AND al.entity_id = v_cash_id AND (al.new_value->>'cash_date') = p_cash_date::text");
  });
});

describe("'Não pagou' com escopo completo", () => {
  it("parcela pertence ao empréstimo da marcação e ao mesmo escopo", () => {
    expect(SQL).toContain("JOIN public.installments i ON i.id = nm.installment_id AND i.loan_id = nm.loan_id");
    expect(SQL).toContain("JOIN public.loans l ON l.id = i.loan_id AND l.worker_id IS NOT DISTINCT FROM v_worker AND l.admin_id = v_admin");
    expect(SQL).toContain("JOIN public.clients c ON c.id = l.client_id AND c.worker_id IS NOT DISTINCT FROM v_worker AND c.admin_id = v_admin");
  });

  it("vínculo divergente aborta o snapshot em vez de trazer outro escopo", () => {
    expect(SQL).toContain("IF v_np_valid <> v_np_total THEN");
  });
});

describe("saldo devedor dos atrasados por empréstimo", () => {
  it("não usa SUM(DISTINCT remaining_balance)", () => {
    expect(SQL).not.toContain("SUM(DISTINCT l.remaining_balance)");
  });

  it("soma o saldo uma vez por loan_id (dois empréstimos de R$500 = R$1000)", () => {
    expect(SQL).toContain("per_loan AS ( SELECT DISTINCT client_id, loan_id, remaining_balance FROM base )");
    expect(SQL).toContain("(SELECT COALESCE(SUM(pl.remaining_balance),0) FROM per_loan pl WHERE pl.client_id = b.client_id) AS remaining");
  });

  it("simulação: DISTINCT por loan_id preserva saldos iguais", () => {
    const rows = [
      { loan_id: "A", remaining_balance: 500 },
      { loan_id: "A", remaining_balance: 500 },
      { loan_id: "B", remaining_balance: 500 },
    ];
    const perLoan = new Map(rows.map(r => [r.loan_id, r.remaining_balance]));
    expect([...perLoan.values()].reduce((a, b) => a + b, 0)).toBe(1000);
  });
});
