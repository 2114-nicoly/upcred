import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Isolamento por trabalhador na criação do snapshot diário.
 * Dois trabalhadores da MESMA empresa com movimentações na mesma data:
 * cada snapshot deve conter somente os próprios registros.
 */

const ADMIN = "admin-1";
const W1 = "worker-1";
const W2 = "worker-2";
const DATE = "2026-07-31";

const DB: Record<string, any[]> = {
  daily_events: [
    { id: "e1", cash_date: DATE, event_type: "pagamento", worker_id: W1, admin_id: ADMIN, client_id: "c1", loan_id: "l1", amount_in: 100, amount_out: 0, reversed_at: null, created_at: "2026-07-31T10:00:00Z", metadata: null, cash_movement_id: "m1" },
    { id: "e2", cash_date: DATE, event_type: "pagamento", worker_id: W2, admin_id: ADMIN, client_id: "c2", loan_id: "l2", amount_in: 250, amount_out: 0, reversed_at: null, created_at: "2026-07-31T11:00:00Z", metadata: null, cash_movement_id: "m2" },
  ],
  not_paid_marks: [
    { id: "n1", mark_date: DATE, worker_id: W1, admin_id: ADMIN, installment_id: "i1", loan_id: "l1", client_id: "c1", observation: null, created_at: "x" },
    { id: "n2", mark_date: DATE, worker_id: W2, admin_id: ADMIN, installment_id: "i2", loan_id: "l2", client_id: "c2", observation: null, created_at: "x" },
  ],
  cash_movements: [
    { id: "m1", cash_date: DATE, type: "recebimento_normal", worker_id: W1, admin_id: ADMIN, loan_id: "l1", installment_id: "i1", client_id: "c1", amount: 100, reversed_at: null, created_at: "2026-07-31T10:00:00Z" },
    { id: "m2", cash_date: DATE, type: "recebimento_normal", worker_id: W2, admin_id: ADMIN, loan_id: "l2", installment_id: "i2", client_id: "c2", amount: 250, reversed_at: null, created_at: "2026-07-31T11:00:00Z" },
  ],
  loans: [
    { id: "l1", loan_date: DATE, worker_id: W1, admin_id: ADMIN, client_id: "c1", amount: 500, total_amount: 600, remaining_balance: 500, status: "open", installment_count: 10, payment_type: "diario", renewed_from_loan_id: null, clients: { id: "c1", name: "Cliente 1" } },
    { id: "l2", loan_date: DATE, worker_id: W2, admin_id: ADMIN, client_id: "c2", amount: 800, total_amount: 900, remaining_balance: 800, status: "open", installment_count: 10, payment_type: "diario", renewed_from_loan_id: null, clients: { id: "c2", name: "Cliente 2" } },
  ],
  installments: [],
  clients: [
    { id: "c1", name: "Cliente 1" },
    { id: "c2", name: "Cliente 2" },
  ],
};

function makeQuery(table: string) {
  let rows = [...(DB[table] || [])];
  const api: any = {
    select: () => api,
    eq: (c: string, v: any) => { rows = rows.filter(r => r[c] === v); return api; },
    is: (c: string, v: any) => { rows = rows.filter(r => (r[c] ?? null) === v); return api; },
    in: (c: string, v: any[]) => { rows = rows.filter(r => v.includes(r[c])); return api; },
    lte: (c: string, v: any) => { rows = rows.filter(r => r[c] <= v); return api; },
    order: () => api,
    limit: () => api,
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then: (res: any) => Promise.resolve({ data: rows, error: null }).then(res),
  };
  return api;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (t: string) => makeQuery(t) },
}));

let currentScope = { worker_id: W1 as string | null, admin_id: ADMIN as string | null };

vi.mock("@/lib/cash-utils", () => ({
  getCurrentDailyCashScope: async () => currentScope,
  applyDailyCashScope: (q: any) => q,
  getCashBalance: async () => ({ available_cash: 0 }),
}));

vi.mock("@/lib/audit-utils", () => ({
  getCurrentActorIdentity: async () => ({ id: "u1", name: "Tester", role: "admin" }),
}));

vi.mock("@/lib/daily-totals", () => ({
  getDailyCollectionSummary: async () => null,
}));

const EXTRA: any = {
  opening_balance: 0, expected_worker_cash: 0, counted_cash: 0, final_cash: 0,
  received: 0, penalty: 0, manual_in: 0, manual_out: 0, expenses: 0,
  new_loans: 0, renewals: 0, lent: 0, total_in: 0, total_out: 0,
  not_paid_count: 0, events_count: 0, observation: null,
};

describe("buildDailyCashSnapshotPayload — isolamento por trabalhador", () => {
  beforeEach(() => { vi.resetModules(); });

  it("inclui somente os registros do trabalhador 1", async () => {
    currentScope = { worker_id: W1, admin_id: ADMIN };
    const { buildDailyCashSnapshotPayload } = await import("@/lib/daily-snapshot");
    const p = await buildDailyCashSnapshotPayload(DATE, EXTRA);
    expect(p.events.map(e => e.id)).toEqual(["e1"]);
    expect(p.events.reduce((s, e) => s + Number(e.amount_in), 0)).toBe(100);
    expect(p.not_paid_marks.map(m => m.id)).toEqual(["n1"]);
    expect(p.new_loans.map(l => l.id)).toEqual(["l1"]);
  });

  it("inclui somente os registros do trabalhador 2", async () => {
    currentScope = { worker_id: W2, admin_id: ADMIN };
    const { buildDailyCashSnapshotPayload } = await import("@/lib/daily-snapshot");
    const p = await buildDailyCashSnapshotPayload(DATE, EXTRA);
    expect(p.events.map(e => e.id)).toEqual(["e2"]);
    expect(p.events.reduce((s, e) => s + Number(e.amount_in), 0)).toBe(250);
    expect(p.not_paid_marks.map(m => m.id)).toEqual(["n2"]);
    expect(p.new_loans.map(l => l.id)).toEqual(["l2"]);
  });
});
