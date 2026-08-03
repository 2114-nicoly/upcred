import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Escopo financeiro do cash-utils: nenhuma leitura/atualização sem admin_id,
 * isolamento total entre empresas e entre trabalhadores, e nenhuma escolha de
 * saldo via limit(1).
 */

const ADMIN_A = "admin-a";
const ADMIN_B = "admin-b";
const W1 = "worker-1";
const W2 = "worker-2";

type Row = Record<string, any>;

const db: Record<string, Row[]> = {
  cash_balance: [],
  cash_movements: [],
  loans: [],
  installments: [],
  workers: [],
  admins: [],
};

let session: any = null;
const usedLimit: string[] = [];
const updates: Array<{ table: string; filters: any[]; values: any }> = [];
const errors: Record<string, any> = {};

function matches(row: Row, filters: any[]): boolean {
  return filters.every((f) => {
    const key = f.col.includes(".") ? f.col.split(".").pop()! : f.col;
    const embedded = f.col.includes(".") ? f.col.split(".")[0] : null;
    const value = embedded ? (row[embedded] ?? {})[key] : row[key];
    if (f.op === "eq") return value === f.val;
    if (f.op === "is") return value === null || value === undefined;
    return true;
  });
}

function makeQuery(table: string) {
  const filters: any[] = [];
  const q: any = {
    select: () => q,
    eq: (col: string, val: any) => { filters.push({ op: "eq", col, val }); return q; },
    is: (col: string) => { filters.push({ op: "is", col }); return q; },
    in: () => q,
    limit: () => { usedLimit.push(table); return q; },
    filters,
    maybeSingle: async () => {
      if (errors[table]) return { data: null, error: errors[table] };
      const rows = (db[table] || []).filter((r) => matches(r, filters));
      if (rows.length > 1) return { data: null, error: { message: "multiple rows" } };
      return { data: rows[0] ?? null, error: null };
    },
    update: (values: any) => {
      const upd: any = {
        eq: (col: string, val: any) => {
          filters.push({ op: "eq", col, val });
          updates.push({ table, filters: [...filters], values });
          return Promise.resolve({ data: null, error: null });
        },
      };
      return upd;
    },
    then: (resolve: any, reject: any) => {
      if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject);
      const rows = (db[table] || []).filter((r) => matches(r, filters));
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return q;
}

const queries: Array<{ table: string; q: any }> = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const q = makeQuery(table);
      queries.push({ table, q });
      return q;
    },
    auth: { getSession: async () => ({ data: { session } }) },
    rpc: async () => ({ data: null, error: null }),
  },
}));

import {
  getCashBalanceResult,
  applyDailyCashScope,
  resolveFinancialScope,
  recalculateCashBalanceFromLedger,
  SCOPE_ADMIN_REQUIRED_MESSAGE,
} from "@/lib/cash-utils";

beforeEach(() => {
  queries.length = 0;
  usedLimit.length = 0;
  updates.length = 0;
  Object.keys(errors).forEach((k) => delete errors[k]);
  session = null;
  db.workers = [
    { id: W1, auth_user_id: "uid-w1", parent_admin_id: ADMIN_A },
    { id: W2, auth_user_id: "uid-w2", parent_admin_id: ADMIN_B },
  ];
  db.admins = [{ id: ADMIN_A, auth_user_id: "uid-a" }, { id: ADMIN_B, auth_user_id: "uid-b" }];
  db.cash_balance = [
    { id: "cb-w1", worker_id: W1, admin_id: ADMIN_A, available_cash: 100 },
    { id: "cb-w2", worker_id: W2, admin_id: ADMIN_B, available_cash: 900 },
    { id: "cb-admin-a", worker_id: null, admin_id: ADMIN_A, available_cash: 10 },
    { id: "cb-admin-b", worker_id: null, admin_id: ADMIN_B, available_cash: 90 },
  ];
  db.cash_movements = [
    { id: "m1", worker_id: W1, admin_id: ADMIN_A, amount: 100, reversed_at: null },
    { id: "m2", worker_id: W2, admin_id: ADMIN_B, amount: 900, reversed_at: null },
    { id: "m3", worker_id: null, admin_id: ADMIN_A, amount: 10, reversed_at: null },
  ];
  db.loans = [];
  db.installments = [];
});

describe("resolveFinancialScope", () => {
  it("usa o escopo explícito do trabalhador com admin informado", async () => {
    expect(await resolveFinancialScope({ workerId: W1, adminId: ADMIN_A }))
      .toEqual({ worker_id: W1, admin_id: ADMIN_A });
  });

  it("completa o admin pelo parent_admin_id quando omitido", async () => {
    expect(await resolveFinancialScope({ workerId: W2 }))
      .toEqual({ worker_id: W2, admin_id: ADMIN_B });
  });

  it("aborta quando o admin_id não pode ser determinado", async () => {
    db.workers = [{ id: "orfao", parent_admin_id: null }];
    await expect(resolveFinancialScope({ workerId: "orfao" }))
      .rejects.toThrow(SCOPE_ADMIN_REQUIRED_MESSAGE);
    await expect(resolveFinancialScope()).rejects.toThrow(SCOPE_ADMIN_REQUIRED_MESSAGE);
  });

  it("admin logado sem trabalhador resolve worker_id nulo + própria empresa", async () => {
    session = { user: { id: "uid-a" } };
    expect(await resolveFinancialScope()).toEqual({ worker_id: null, admin_id: ADMIN_A });
  });
});

describe("getCashBalanceResult", () => {
  it("empresa A não lê o saldo da empresa B", async () => {
    const a = await getCashBalanceResult({ workerId: W1, adminId: ADMIN_A });
    expect(a.data?.id).toBe("cb-w1");
    const cross = await getCashBalanceResult({ workerId: W1, adminId: ADMIN_B });
    expect(cross.data).toBeNull();
  });

  it("trabalhador 1 não lê o saldo do trabalhador 2", async () => {
    const r = await getCashBalanceResult({ workerId: W2, adminId: ADMIN_B });
    expect(r.data?.id).toBe("cb-w2");
    expect(r.data?.available_cash).toBe(900);
  });

  it("admin sem trabalhador lê somente a própria linha (worker_id IS NULL)", async () => {
    const r = await getCashBalanceResult({ adminId: ADMIN_A });
    expect(r.data?.id).toBe("cb-admin-a");
  });

  it("sem admin determinável retorna erro e não consulta saldo", async () => {
    const r = await getCashBalanceResult();
    expect(r.data).toBeNull();
    expect(r.error?.message).toBe(SCOPE_ADMIN_REQUIRED_MESSAGE);
  });

  it("nunca usa limit(1) e sempre filtra admin_id", async () => {
    await getCashBalanceResult({ workerId: W1, adminId: ADMIN_A });
    expect(usedLimit).toHaveLength(0);
    const cb = queries.find((q) => q.table === "cash_balance")!;
    expect(cb.q.filters.some((f: any) => f.col === "admin_id" && f.val === ADMIN_A)).toBe(true);
  });
});

describe("applyDailyCashScope", () => {
  it("aplica worker_id + admin_id juntos", () => {
    const q = makeQuery("daily_cash");
    applyDailyCashScope(q, { worker_id: W1, admin_id: ADMIN_A });
    expect(q.filters).toEqual([
      { op: "eq", col: "worker_id", val: W1 },
      { op: "eq", col: "admin_id", val: ADMIN_A },
    ]);
  });

  it("rejeita worker_id sem admin_id e escopo vazio", () => {
    expect(() => applyDailyCashScope(makeQuery("daily_cash"), { worker_id: W1, admin_id: null }))
      .toThrow(SCOPE_ADMIN_REQUIRED_MESSAGE);
    expect(() => applyDailyCashScope(makeQuery("daily_cash"), { worker_id: null, admin_id: null }))
      .toThrow(SCOPE_ADMIN_REQUIRED_MESSAGE);
  });
});

describe("recalculateCashBalanceFromLedger", () => {
  it("atualiza somente a linha exata do trabalhador da empresa correta", async () => {
    await recalculateCashBalanceFromLedger({ workerId: W1, adminId: ADMIN_A });
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("cash_balance");
    expect(updates[0].filters.some((f: any) => f.col === "id" && f.val === "cb-w1")).toBe(true);
    expect(updates[0].values.available_cash).toBe(100);
  });

  it("não soma movimentações de outra empresa", async () => {
    await recalculateCashBalanceFromLedger({ workerId: W2, adminId: ADMIN_B });
    expect(updates[0].values.available_cash).toBe(900);
  });

  it("admin sem trabalhador usa apenas registros worker_id IS NULL da empresa", async () => {
    await recalculateCashBalanceFromLedger({ adminId: ADMIN_A });
    expect(updates[0].filters.some((f: any) => f.col === "id" && f.val === "cb-admin-a")).toBe(true);
    expect(updates[0].values.available_cash).toBe(10);
  });

  it("aborta sem admin_id", async () => {
    await expect(recalculateCashBalanceFromLedger()).rejects.toThrow(SCOPE_ADMIN_REQUIRED_MESSAGE);
    expect(updates).toHaveLength(0);
  });

  it("erro de consulta cancela o recálculo (nunca vira lista vazia)", async () => {
    errors.cash_movements = { message: "boom" };
    await expect(recalculateCashBalanceFromLedger({ workerId: W1, adminId: ADMIN_A }))
      .rejects.toMatchObject({ message: "boom" });
    expect(updates).toHaveLength(0);
  });
});
