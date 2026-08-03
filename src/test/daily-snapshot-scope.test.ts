import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Snapshot diário: escopo explícito, isolamento por empresa/trabalhador,
 * erro nunca vira lista vazia e nenhum pagamento antigo é reconstruído
 * a partir do saldo atual do empréstimo.
 */

const ADMIN_A = "admin-a";
const ADMIN_B = "admin-b";
const W1 = "worker-1";
const W2 = "worker-2";
const W3 = "worker-3"; // pertence ao ADMIN_B
const DATE = "2026-07-31";

type Row = Record<string, any>;

const baseDB = (): Record<string, Row[]> => ({
  daily_events: [
    { id: "e1", cash_date: DATE, event_type: "pagamento", worker_id: W1, admin_id: ADMIN_A, client_id: "c1", loan_id: "l1", amount_in: 100, amount_out: 0, reversed_at: null, created_at: "2026-07-31T10:00:00Z", cash_movement_id: "m1", metadata: null },
    { id: "e2", cash_date: DATE, event_type: "pagamento", worker_id: W2, admin_id: ADMIN_A, client_id: "c2", loan_id: "l2", amount_in: 250, amount_out: 0, reversed_at: null, created_at: "2026-07-31T11:00:00Z", cash_movement_id: "m2", metadata: null },
    { id: "e3", cash_date: DATE, event_type: "pagamento", worker_id: W3, admin_id: ADMIN_B, client_id: "c3", loan_id: "l3", amount_in: 999, amount_out: 0, reversed_at: null, created_at: "2026-07-31T12:00:00Z", cash_movement_id: "m3", metadata: null },
    { id: "e4", cash_date: DATE, event_type: "pagamento", worker_id: W1, admin_id: null, client_id: "c9", loan_id: "l9", amount_in: 77, amount_out: 0, reversed_at: null, created_at: "2026-07-31T13:00:00Z", cash_movement_id: "m9", metadata: null },
  ],
  not_paid_marks: [
    { id: "n1", mark_date: DATE, worker_id: W1, admin_id: ADMIN_A, installment_id: "i1", loan_id: "l1", client_id: "c1", observation: null, created_at: "x" },
    { id: "n2", mark_date: DATE, worker_id: W2, admin_id: ADMIN_A, installment_id: "i2", loan_id: "l2", client_id: "c2", observation: null, created_at: "x" },
    { id: "n3", mark_date: DATE, worker_id: W3, admin_id: ADMIN_B, installment_id: "i3", loan_id: "l3", client_id: "c3", observation: null, created_at: "x" },
  ],
  cash_movements: [
    { id: "m1", cash_date: DATE, type: "recebimento_normal", worker_id: W1, admin_id: ADMIN_A, loan_id: "l1", client_id: "c1", installment_id: "i1", amount: 100, reversed_at: null, created_at: "2026-07-31T10:00:00Z", daily_event_id: "e1" },
    { id: "m2", cash_date: DATE, type: "recebimento_normal", worker_id: W2, admin_id: ADMIN_A, loan_id: "l2", client_id: "c2", installment_id: "i2", amount: 250, reversed_at: null, created_at: "2026-07-31T11:00:00Z", daily_event_id: "e2" },
    { id: "m3", cash_date: DATE, type: "recebimento_normal", worker_id: W3, admin_id: ADMIN_B, loan_id: "l3", client_id: "c3", installment_id: "i3", amount: 999, reversed_at: null, created_at: "2026-07-31T12:00:00Z", daily_event_id: "e3" },
  ],
  loans: [
    { id: "l1", loan_date: DATE, worker_id: W1, admin_id: ADMIN_A, client_id: "c1", amount: 500, total_amount: 600, remaining_balance: 500, status: "open", installment_count: 10, payment_type: "diario", renewed_from_loan_id: null, clients: { id: "c1", name: "Cliente 1" } },
    { id: "l2", loan_date: DATE, worker_id: W2, admin_id: ADMIN_A, client_id: "c2", amount: 800, total_amount: 900, remaining_balance: 800, status: "open", installment_count: 10, payment_type: "diario", renewed_from_loan_id: null, clients: { id: "c2", name: "Cliente 2" } },
    { id: "l3", loan_date: DATE, worker_id: W3, admin_id: ADMIN_B, client_id: "c3", amount: 300, total_amount: 400, remaining_balance: 300, status: "open", installment_count: 10, payment_type: "diario", renewed_from_loan_id: null, clients: { id: "c3", name: "Cliente 3" } },
  ],
  installments: [],
  clients: [
    { id: "c1", name: "Cliente 1" },
    { id: "c2", name: "Cliente 2" },
    { id: "c3", name: "Cliente 3" },
    { id: "c9", name: "Cliente 9" },
  ],
  workers: [
    { id: W1, nome: "Trabalhador 1", parent_admin_id: ADMIN_A },
    { id: W2, nome: "Trabalhador 2", parent_admin_id: ADMIN_A },
    { id: W3, nome: "Trabalhador 3", parent_admin_id: ADMIN_B },
  ],

  admins: [
    { id: ADMIN_A, nome: "Empresa A" },
    { id: ADMIN_B, nome: "Empresa B" },
  ],
  daily_cash_snapshots: [
    { id: "s1", cash_date: DATE, worker_id: W1, admin_id: ADMIN_A, version: 1, daily_cash_id: "dc1", closed_at: "x", closed_by: null, reopen_reason: null, created_at: "x", payload: { cash_date: DATE, scope: { worker_id: W1, admin_id: ADMIN_A }, tag: "w1" } },
    { id: "s2", cash_date: DATE, worker_id: W1, admin_id: ADMIN_B, version: 1, daily_cash_id: "dc2", closed_at: "x", closed_by: null, reopen_reason: null, created_at: "x", payload: { cash_date: DATE, scope: { worker_id: W1, admin_id: ADMIN_B }, tag: "w1-b" } },
  ],
});

let DB = baseDB();
/** Tabelas que devem falhar na consulta. */
let failing = new Set<string>();
const queriedTables: string[] = [];

function makeQuery(table: string) {
  queriedTables.push(table);
  let rows = [...(DB[table] || [])];
  const result = () =>
    failing.has(table)
      ? { data: null, error: { message: `falha simulada em ${table}` } }
      : { data: rows, error: null };
  const api: any = {
    select: () => api,
    eq: (c: string, v: any) => { rows = rows.filter(r => r[c] === v); return api; },
    is: (c: string, v: any) => { rows = rows.filter(r => (r[c] ?? null) === v); return api; },
    in: (c: string, v: any[]) => { rows = rows.filter(r => v.includes(r[c])); return api; },
    lte: (c: string, v: any) => { rows = rows.filter(r => r[c] <= v); return api; },
    order: () => api,
    limit: () => api,
    maybeSingle: () => Promise.resolve(
      failing.has(table)
        ? { data: null, error: { message: `falha simulada em ${table}` } }
        : { data: rows[0] ?? null, error: null },
    ),
    then: (res: any) => Promise.resolve(result()).then(res),
  };
  return api;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (t: string) => makeQuery(t) },
}));

/** Escopo do usuário autenticado — deve ser IGNORADO pelo build. */
let authenticatedScope = { worker_id: "usuario-autenticado" as string | null, admin_id: "admin-do-usuario" as string | null };

vi.mock("@/lib/cash-utils", () => ({
  getCurrentDailyCashScope: async (explicit?: any) => {
    if (explicit?.workerId) return { worker_id: explicit.workerId, admin_id: explicit.adminId ?? null };
    if (explicit?.adminId) return { worker_id: null, admin_id: explicit.adminId };
    return authenticatedScope;
  },
  applyDailyCashScope: (q: any) => q,
  getCashBalance: async () => ({ available_cash: 0 }),
  getCashBalanceResult: async (s: any) =>
    cashBalanceResult ?? {
      data: { available_cash: 1000, worker_id: s?.workerId ?? null, admin_id: s?.adminId ?? null },
      error: null,
    },
}));

/** null = comportamento padrão (linha do escopo solicitado). */
let cashBalanceResult: any = null;


vi.mock("@/lib/audit-utils", () => ({
  getCurrentActorIdentity: async () => ({ id: "u1", name: "Tester", role: "admin" }),
}));

let summary: any = {
  expectedToReceiveToday: 0, receivedToday: 0, receivedFromExpected: 0,
  pendingToReceiveToday: 0, overdueAmount: 0, cashExpectedForClosing: 0, hasError: false,
};
vi.mock("@/lib/daily-totals", () => ({
  getDailyCollectionSummary: async () => summary,
}));

const EXTRA = {
  opening_balance: 0, expected_worker_cash: 0, counted_cash: 0, final_cash: 0,
  received: 0, penalty: 0, manual_in: 0, manual_out: 0, expenses: 0,
  new_loans: 0, renewals: 0, lent: 0, total_in: 0, total_out: 0,
  not_paid_count: 0, events_count: 0, observation: null,
};

async function build(workerId: string | null, adminId: string | null) {
  const { buildDailyCashSnapshotPayload } = await import("@/lib/daily-snapshot");
  return await buildDailyCashSnapshotPayload({ cashDate: DATE, workerId, adminId, extra: EXTRA });
}

beforeEach(() => {
  vi.resetModules();
  DB = baseDB();
  failing = new Set();
  queriedTables.length = 0;
  cashBalanceResult = { data: { available_cash: 1000, worker_id: W1, admin_id: ADMIN_A }, error: null };
  summary = {
    expectedToReceiveToday: 0, receivedToday: 0, receivedFromExpected: 0,
    pendingToReceiveToday: 0, overdueAmount: 0, cashExpectedForClosing: 0, hasError: false,
  };
  authenticatedScope = { worker_id: "usuario-autenticado", admin_id: "admin-do-usuario" };
});

describe("buildDailyCashSnapshotPayload — escopo explícito e isolamento", () => {
  it("dois trabalhadores da mesma empresa não se misturam", async () => {
    const p1 = await build(W1, ADMIN_A);
    expect(p1.events.map(e => e.id)).toEqual(["e1"]);
    expect(p1.not_paid_marks.map(m => m.id)).toEqual(["n1"]);
    expect(p1.new_loans.map(l => l.id)).toEqual(["l1"]);

    vi.resetModules();
    const p2 = await build(W2, ADMIN_A);
    expect(p2.events.map(e => e.id)).toEqual(["e2"]);
    expect(p2.not_paid_marks.map(m => m.id)).toEqual(["n2"]);
    expect(p2.new_loans.map(l => l.id)).toEqual(["l2"]);
  });

  it("empresas diferentes na mesma data não se misturam", async () => {
    const pB = await build(W3, ADMIN_B);
    expect(pB.events.map(e => e.id)).toEqual(["e3"]);
    expect(pB.scope).toEqual({ worker_id: W3, admin_id: ADMIN_B });
    expect(pB.scope_names?.admin_name).toBe("Empresa B");
  });

  it("registro com admin_id NULL é rejeitado (não entra no escopo com adminId)", async () => {
    const p = await build(W1, ADMIN_A);
    expect(p.events.some(e => e.id === "e4")).toBe(false);
  });

  it("usa o escopo explícito, ignorando o usuário autenticado", async () => {
    authenticatedScope = { worker_id: W2, admin_id: ADMIN_A };
    const p = await build(W1, ADMIN_A);
    expect(p.scope).toEqual({ worker_id: W1, admin_id: ADMIN_A });
    expect(p.events.map(e => e.id)).toEqual(["e1"]);
    expect(p.scope_names?.worker_name).toBe("Trabalhador 1");
  });

  it("consulta bem-sucedida sem registros aceita array vazio", async () => {
    DB.daily_events = [];
    DB.not_paid_marks = [];
    DB.loans = [];
    DB.cash_movements = [];
    const p = await build(W1, ADMIN_A);
    expect(p.events).toEqual([]);
    expect(p.not_paid_marks).toEqual([]);
    expect(p.paid_groups).toEqual([]);
  });
});

describe("buildDailyCashSnapshotPayload — falhas obrigatórias", () => {
  const MSG = "Não foi possível congelar todas as informações. O caixa continua aberto.";

  it("falha em daily_events rejeita o snapshot", async () => {
    failing.add("daily_events");
    await expect(build(W1, ADMIN_A)).rejects.toThrow(MSG);
  });

  it("falha em not_paid_marks rejeita o snapshot", async () => {
    failing.add("not_paid_marks");
    await expect(build(W1, ADMIN_A)).rejects.toThrow(MSG);
  });

  it("falha em cash_movements rejeita o snapshot", async () => {
    failing.add("cash_movements");
    await expect(build(W1, ADMIN_A)).rejects.toThrow(MSG);
  });

  it("falha em clients rejeita o snapshot", async () => {
    failing.add("clients");
    await expect(build(W1, ADMIN_A)).rejects.toThrow(MSG);
  });

  it("falha no nome do trabalhador rejeita o snapshot", async () => {
    failing.add("workers");
    await expect(build(W1, ADMIN_A)).rejects.toThrow(MSG);
  });

  it("cash_balance ausente rejeita o snapshot", async () => {
    cashBalanceResult = { data: null, error: null };
    await expect(build(W1, ADMIN_A)).rejects.toThrow(MSG);
  });

  it("erro de consulta no cash_balance rejeita o snapshot", async () => {
    cashBalanceResult = { data: null, error: { message: "boom" } };
    await expect(build(W1, ADMIN_A)).rejects.toThrow(MSG);
  });

  it("resumo diário com erro rejeita o snapshot", async () => {
    summary = { ...summary, hasError: true };
    await expect(build(W1, ADMIN_A)).rejects.toThrow(MSG);
  });
});

describe("buildDailyCashSnapshotPayload — pagamentos congelados", () => {
  it("pagamento antigo sem metadata não usa o saldo atual do empréstimo", async () => {
    const p = await build(W1, ADMIN_A);
    const g = p.paid_groups[0];
    expect(g.hasFrozenProgress).toBe(false);
    expect(g.remainingAfter).toBeNull();
    expect(g.progressAfterFormatted).toBeNull();
    expect(g.instAmount).toBeNull();
  });

  it("pagamento com metadata congelado preserva o progresso salvo", async () => {
    DB.daily_events[0].metadata = {
      client_name: "Cliente 1",
      client_id: "c1",
      loan_id: "l1",
      cash_movement_id: "m1",
      payment_amount: 100,
      remaining_balance_before: 400,
      remaining_balance_after: 300,
      installment_progress_before: "3/24",
      installment_progress_after: "4/24",
      progress_units_before: 3,
      progress_units_after: 4,
      installments_advanced: 1,
      total_installments: 24,
      installment_amount: 100,
      affected_installments: [{ installment_id: "i1" }],
    };
    // saldo atual bem diferente: não pode influenciar o card
    DB.loans[0].remaining_balance = 10;
    const p = await build(W1, ADMIN_A);
    const g = p.paid_groups[0];
    expect(g.hasFrozenProgress).toBe(true);
    expect(g.progressBeforeFormatted).toBe("3/24");
    expect(g.progressAfterFormatted).toBe("4/24");
    expect(g.remainingAfter).toBe(300);
  });
});

describe("leitura dos snapshots — worker_id e admin_id juntos", () => {
  it("load filtra worker_id e admin_id simultaneamente", async () => {
    const { loadDailyCashSnapshot } = await import("@/lib/daily-snapshot");
    const a = await loadDailyCashSnapshot(DATE, { workerId: W1, adminId: ADMIN_A });
    expect((a as any)?.tag).toBe("w1");
    const b = await loadDailyCashSnapshot(DATE, { workerId: W1, adminId: ADMIN_B });
    expect((b as any)?.tag).toBe("w1-b");
    const none = await loadDailyCashSnapshot(DATE, { workerId: W2, adminId: ADMIN_A });
    expect(none).toBeNull();
  });

  it("list filtra worker_id e admin_id simultaneamente", async () => {
    const { listDailyCashSnapshotVersions } = await import("@/lib/daily-snapshot");
    const list = await listDailyCashSnapshotVersions(DATE, { workerId: W1, adminId: ADMIN_A });
    expect(list.map(v => v.id)).toEqual(["s1"]);
  });

  it("erro de consulta na leitura não vira 'snapshot inexistente'", async () => {
    failing.add("daily_cash_snapshots");
    const { loadDailyCashSnapshot } = await import("@/lib/daily-snapshot");
    await expect(loadDailyCashSnapshot(DATE, { workerId: W1, adminId: ADMIN_A })).rejects.toThrow();
  });
});
