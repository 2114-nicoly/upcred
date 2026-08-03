import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchActiveCash,
  resolveOperationalDate,
  requireActiveCashDate,
  assertOperationDate,
  openCashNoticeMessage,
  wrongCashDateMessage,
  NO_ACTIVE_CASH_MESSAGE,
} from "@/lib/active-cash";
import { assertCashOpen, getTodayCashDate } from "@/lib/cash-lock";

const rpc = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: any[]) => rpc(...args) },
}));

/** Banco simulado: um caixa aberto por escopo exato (worker_id + admin_id). */
type Row = { id: string; cash_date: string; status: string; worker_id: string | null; admin_id: string | null; opening_balance: number };

function mockDb(rows: Row[]) {
  rpc.mockImplementation(async (_fn: string, params: any) => {
    const wid = params.p_worker_id ?? null;
    const aid = params.p_admin_id ?? null;
    const row = rows.find(
      (r) => r.worker_id === wid && r.admin_id === aid && r.status === "open"
    );
    return { data: row ? [row] : [], error: null };
  });
}

const cashW1: Row = { id: "c1", cash_date: "2026-07-28", status: "open", worker_id: "w1", admin_id: "a1", opening_balance: 100 };
const cashW2: Row = { id: "c2", cash_date: "2026-08-03", status: "open", worker_id: "w2", admin_id: "a2", opening_balance: 0 };
const cashAdmin: Row = { id: "c3", cash_date: "2026-08-02", status: "open", worker_id: null, admin_id: "a1", opening_balance: 50 };

beforeEach(() => {
  rpc.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-03T15:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("caixa ativo por escopo", () => {
  it("trabalhador com caixa antigo aberto usa a data antiga", async () => {
    mockDb([cashW1]);
    const { date, activeCash } = await resolveOperationalDate({ workerId: "w1", adminId: "a1" });
    expect(date).toBe("2026-07-28");
    expect(activeCash?.id).toBe("c1");
  });

  it("administrador da própria empresa enxerga o caixa administrativo", async () => {
    mockDb([cashAdmin, cashW1]);
    const cash = await fetchActiveCash({ workerId: null, adminId: "a1" });
    expect(cash?.cashDate).toBe("2026-08-02");
  });

  it("isolamento entre duas empresas: escopo A não vê caixa de B", async () => {
    mockDb([cashW1, cashW2]);
    const a = await fetchActiveCash({ workerId: "w1", adminId: "a1" });
    const b = await fetchActiveCash({ workerId: "w2", adminId: "a2" });
    const cruzado = await fetchActiveCash({ workerId: "w1", adminId: "a2" });
    expect(a?.cashDate).toBe("2026-07-28");
    expect(b?.cashDate).toBe("2026-08-03");
    expect(cruzado).toBeNull();
  });

  it("super admin com trabalhador selecionado consulta o escopo exato", async () => {
    mockDb([cashW2]);
    const cash = await fetchActiveCash({ workerId: "w2", adminId: "a2" });
    expect(cash?.id).toBe("c2");
    expect(rpc).toHaveBeenCalledWith("get_active_daily_cash_for_scope", {
      p_worker_id: "w2",
      p_admin_id: "a2",
    });
  });

  it("sem caixa aberto: data operacional é hoje em São Paulo", async () => {
    mockDb([]);
    const { date, activeCash } = await resolveOperationalDate({ workerId: "w9", adminId: "a9" });
    expect(activeCash).toBeNull();
    expect(date).toBe(getTodayCashDate());
  });
});

describe("bloqueio de operações fora do caixa ativo", () => {
  it("operação em data diferente é bloqueada com a data do caixa ativo", async () => {
    mockDb([cashW1]);
    await expect(assertOperationDate("2026-08-03", { workerId: "w1", adminId: "a1" }))
      .rejects.toThrow(wrongCashDateMessage("2026-07-28"));
  });

  it("operação na data do caixa ativo é permitida", async () => {
    mockDb([cashW1]);
    await expect(assertOperationDate("2026-07-28", { workerId: "w1", adminId: "a1" })).resolves.toMatchObject({ id: "c1" });
  });

  it("ausência de caixa bloqueia qualquer operação", async () => {
    mockDb([]);
    await expect(requireActiveCashDate({ workerId: "w1", adminId: "a1" })).rejects.toThrow(NO_ACTIVE_CASH_MESSAGE);
    await expect(assertCashOpen("2026-08-03", { workerId: "w1", adminId: "a1" })).rejects.toThrow(NO_ACTIVE_CASH_MESSAGE);
  });

  it("assertCashOpen não aceita data só por não estar fechada", async () => {
    mockDb([cashW1]);
    await expect(assertCashOpen(getTodayCashDate(), { workerId: "w1", adminId: "a1" })).rejects.toThrow(/28\/07\/2026/);
  });
});

describe("empréstimo importado x caixa ativo", () => {
  it("mantém data histórica no empréstimo e usa a data do caixa ativo no evento", async () => {
    mockDb([cashW1]);
    const historicalLoanDate = "2025-11-02";
    const activeDate = await requireActiveCashDate({ workerId: "w1", adminId: "a1" });
    const importedEvent = { cash_date: activeDate, metadata: { original_loan_date: historicalLoanDate } };
    expect(importedEvent.cash_date).toBe("2026-07-28");
    expect(importedEvent.cash_date).not.toBe(getTodayCashDate());
    expect(importedEvent.metadata.original_loan_date).toBe(historicalLoanDate);
  });
});

describe("Rota e Caixa abrem na mesma data", () => {
  it("as duas telas resolvem a mesma data operacional", async () => {
    mockDb([cashW1]);
    const rota = await resolveOperationalDate({ workerId: "w1", adminId: "a1" });
    const caixa = await resolveOperationalDate({ workerId: "w1", adminId: "a1" });
    expect(rota.date).toBe(caixa.date);
    expect(openCashNoticeMessage(rota.date)).toContain("28/07/2026");
  });
});
