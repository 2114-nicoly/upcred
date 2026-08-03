import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Caixa por ESCOPO do empréstimo/cliente.
 * Administrador com empréstimos de dois trabalhadores: cada ação precisa usar
 * o caixa do dono, nunca o caixa administrativo ou de outro trabalhador.
 */

const rpc = vi.fn();
const from = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: any[]) => rpc(...args),
    from: (...args: any[]) => from(...args),
  },
}));

import {
  assertScopedCashOpen,
  getLoanCashScope,
  getClientCashScope,
  scopeKey,
  sameScope,
  NO_SCOPE_CASH_MESSAGE,
} from "@/lib/loan-cash";

// Dois trabalhadores da mesma empresa, com caixas em datas diferentes.
const ADMIN = "admin-1";
const W1 = "worker-1";
const W2 = "worker-2";
const CASH = {
  [W1]: { id: "c1", cash_date: "2026-02-10", status: "open", worker_id: W1, admin_id: ADMIN, opening_balance: 0 },
  [W2]: { id: "c2", cash_date: "2026-02-12", status: "open", worker_id: W2, admin_id: ADMIN, opening_balance: 0 },
} as Record<string, any>;

function mockRows(rows: Record<string, any>) {
  from.mockImplementation(() => ({
    select: () => ({
      eq: (_col: string, id: string) => ({
        maybeSingle: async () => ({ data: rows[id] ?? null, error: null }),
      }),
    }),
  }));
}

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  rpc.mockImplementation(async (_fn: string, params: any) => {
    // O servidor só devolve o caixa do escopo exato solicitado.
    const w = params.p_worker_id;
    if (!w) return { data: null, error: null };
    const row = CASH[w];
    if (!row) return { data: null, error: null };
    if (params.p_admin_id && params.p_admin_id !== row.admin_id) {
      return { data: null, error: { message: "escopo inválido" } };
    }
    return { data: [row], error: null };
  });
});

describe("escopo do caixa por empréstimo", () => {
  it("pagamento usa o caixa do dono do empréstimo", async () => {
    const active = await assertScopedCashOpen("2026-02-10", { workerId: W1, adminId: ADMIN });
    expect(active.cashDate).toBe("2026-02-10");
    expect(rpc).toHaveBeenCalledWith("get_active_daily_cash_for_scope", {
      p_worker_id: W1,
      p_admin_id: ADMIN,
    });
  });

  it("bloqueia usar a data do caixa de outro trabalhador", async () => {
    await expect(
      assertScopedCashOpen("2026-02-12", { workerId: W1, adminId: ADMIN })
    ).rejects.toThrow(/10\/02\/2026/);
  });

  it("trabalhador sem caixa aberto bloqueia a operação (nada é gravado)", async () => {
    await expect(
      assertScopedCashOpen("2026-02-10", { workerId: "worker-sem-caixa", adminId: ADMIN })
    ).rejects.toThrow(NO_SCOPE_CASH_MESSAGE);
  });

  it("nunca cai no caixa administrativo quando não há trabalhador", async () => {
    await expect(
      assertScopedCashOpen("2026-02-10", { workerId: null, adminId: ADMIN })
    ).rejects.toThrow(NO_SCOPE_CASH_MESSAGE);
  });

  it("troca de trabalhador muda a chave do escopo e a data", async () => {
    expect(sameScope({ workerId: W1, adminId: ADMIN }, { workerId: W2, adminId: ADMIN })).toBe(false);
    expect(scopeKey({ workerId: W1, adminId: ADMIN })).toBe(`${W1}|${ADMIN}`);
    const a = await assertScopedCashOpen("2026-02-10", { workerId: W1, adminId: ADMIN });
    const b = await assertScopedCashOpen("2026-02-12", { workerId: W2, adminId: ADMIN });
    expect(a.cashDate).not.toBe(b.cashDate);
  });

  it("escopo do empréstimo vem do próprio registro", async () => {
    mockRows({ "loan-1": { worker_id: W2, admin_id: ADMIN } });
    expect(await getLoanCashScope("loan-1")).toEqual({ workerId: W2, adminId: ADMIN });
  });

  it("novo empréstimo usa o caixa do trabalhador do cliente", async () => {
    mockRows({ "client-1": { name: "Ana", worker_id: W2, admin_id: ADMIN } });
    const scope = await getClientCashScope("client-1");
    expect(scope).toEqual({ name: "Ana", workerId: W2, adminId: ADMIN });
    const active = await assertScopedCashOpen("2026-02-12", scope);
    expect(active.cashDate).toBe("2026-02-12");
  });

  it("importado mantém data histórica, mas o evento usa o caixa do trabalhador", async () => {
    const historicalLoanDate = "2025-11-03";
    const active = await assertScopedCashOpen("2026-02-12", { workerId: W2, adminId: ADMIN });
    expect(historicalLoanDate).not.toBe(active.cashDate);
    expect(active.cashDate).toBe(CASH[W2].cash_date);
  });
});
