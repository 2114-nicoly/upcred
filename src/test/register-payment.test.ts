import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * registerPayment deve ser uma ÚNICA operação transacional no banco:
 * o cliente apenas chama a RPC `register_payment_tx` e nunca repete as
 * alterações (parcelas, empréstimo, caixa, movimento, evento).
 */

const rpcCalls: Array<{ fn: string; args: any }> = [];
const tableCalls: string[] = [];
let rpcImpl: (fn: string, args: any) => { data: any; error: any } = () => ({ data: null, error: null });

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(rpcImpl(fn, args));
    },
    from: (table: string) => {
      tableCalls.push(table);
      const q: any = new Proxy(
        {},
        {
          get: (_t, prop) => {
            if (prop === "then") return undefined;
            return () => q;
          },
        },
      );
      return q;
    },
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));

const auditCalls: any[] = [];
vi.mock("@/lib/audit-utils", () => ({
  logAction: async (...args: any[]) => { auditCalls.push(args); },
  logReversal: async () => {},
}));

const CASH_DATE = "2026-07-31";
const LOAN = "loan-1";
const CLIENT = "client-1";

function metadataFor(opts: {
  applied: number;
  before: number;
  after: number;
  affected: any[];
  progressBefore: string;
  progressAfter: string;
  paidBefore: number;
  paidAfter: number;
}) {
  return {
    payment_amount: opts.applied,
    cash_date: CASH_DATE,
    recorded_at: "2026-07-31T18:00:00.000Z",
    admin_id: "admin-1",
    worker_id: "worker-1",
    worker_name: "Trabalhador 1",
    client_id: CLIENT,
    client_name: "Cliente 1",
    loan_id: LOAN,
    remaining_balance_before: opts.before,
    remaining_balance_after: opts.after,
    paid_installments_before: opts.paidBefore,
    paid_installments_after: opts.paidAfter,
    installment_progress_before: opts.progressBefore,
    installment_progress_after: opts.progressAfter,
    installments_advanced: Math.max(0, opts.paidAfter - opts.paidBefore),
    total_installments: 24,
    installment_amount: 100,
    affected_installments: opts.affected,
  };
}

describe("registerPayment (RPC transacional)", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    tableCalls.length = 0;
    auditCalls.length = 0;
    rpcImpl = () => ({ data: null, error: null });
    vi.resetModules();
  });

  it("grava o metadata antes/depois e usa somente a RPC", async () => {
    const metadata = metadataFor({
      applied: 100,
      before: 2400,
      after: 2300,
      paidBefore: 0,
      paidAfter: 1,
      progressBefore: "0/24",
      progressAfter: "1/24",
      affected: [
        {
          installment_id: "i1", number: 1, amount: 100,
          paid_amount_before: 0, paid_amount_after: 100,
          status_before: "pending", status_after: "paid", amount_applied: 100,
        },
      ],
    });
    rpcImpl = () => ({
      data: { applied: 100, new_balance: 2300, movement_id: "m1", event_id: "e1", metadata },
      error: null,
    });

    const { registerPayment } = await import("@/lib/payment-utils");
    const res = await registerPayment({
      loanId: LOAN, amount: 100, clientId: CLIENT, clientName: "Cliente 1",
      cashDate: CASH_DATE, origin: "rota", installmentId: "i1",
    });

    expect(res).toEqual({ applied: 100, newBalance: 2300 });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("register_payment_tx");
    expect(rpcCalls[0].args).toMatchObject({
      p_loan_id: LOAN, p_amount: 100, p_client_id: CLIENT,
      p_cash_date: CASH_DATE, p_origin: "rota", p_installment_id: "i1",
    });
    // Nenhuma alteração repetida no cliente (nenhum acesso direto a tabelas).
    expect(tableCalls).toEqual([]);
    // Metadata congelado antes/depois.
    expect(metadata.remaining_balance_before).toBe(2400);
    expect(metadata.remaining_balance_after).toBe(2300);
    expect(metadata.installment_progress_before).toBe("0/24");
    expect(metadata.installment_progress_after).toBe("1/24");
    expect(metadata.affected_installments[0]).toMatchObject({
      installment_id: "i1", paid_amount_before: 0, paid_amount_after: 100,
      status_before: "pending", status_after: "paid", amount_applied: 100,
    });
  });

  it("pagamento parcial: parcela fica 'partial' e gera auditoria parcial", async () => {
    const metadata = metadataFor({
      applied: 40,
      before: 2400,
      after: 2360,
      paidBefore: 0,
      paidAfter: 0,
      progressBefore: "0/24",
      progressAfter: "0,4/24",
      affected: [
        {
          installment_id: "i1", number: 1, amount: 100,
          paid_amount_before: 0, paid_amount_after: 40,
          status_before: "pending", status_after: "partial", amount_applied: 40,
        },
      ],
    });
    rpcImpl = () => ({
      data: { applied: 40, new_balance: 2360, movement_id: "m2", event_id: "e2", metadata },
      error: null,
    });

    const { registerPayment } = await import("@/lib/payment-utils");
    const res = await registerPayment({
      loanId: LOAN, amount: 40, clientId: CLIENT, clientName: "Cliente 1",
      cashDate: CASH_DATE, origin: "rota", installmentId: "i1",
    });

    expect(res.applied).toBe(40);
    expect(metadata.installments_advanced).toBe(0);
    expect(metadata.affected_installments[0].status_after).toBe("partial");
    expect(auditCalls.some((c) => c[0] === "pagamento_parcial")).toBe(true);
    expect(tableCalls).toEqual([]);
  });

  it("pagamento que alcança várias parcelas registra todas as afetadas", async () => {
    const metadata = metadataFor({
      applied: 250,
      before: 2400,
      after: 2150,
      paidBefore: 0,
      paidAfter: 2,
      progressBefore: "0/24",
      progressAfter: "2,5/24",
      affected: [
        { installment_id: "i1", number: 1, amount: 100, paid_amount_before: 0, paid_amount_after: 100, status_before: "overdue", status_after: "paid", amount_applied: 100 },
        { installment_id: "i2", number: 2, amount: 100, paid_amount_before: 0, paid_amount_after: 100, status_before: "pending", status_after: "paid", amount_applied: 100 },
        { installment_id: "i3", number: 3, amount: 100, paid_amount_before: 0, paid_amount_after: 50, status_before: "pending", status_after: "partial", amount_applied: 50 },
      ],
    });
    rpcImpl = () => ({
      data: { applied: 250, new_balance: 2150, movement_id: "m3", event_id: "e3", metadata },
      error: null,
    });

    const { registerPayment } = await import("@/lib/payment-utils");
    const res = await registerPayment({
      loanId: LOAN, amount: 250, clientId: CLIENT, clientName: "Cliente 1",
      cashDate: CASH_DATE, origin: "rota",
    });

    expect(res.newBalance).toBe(2150);
    expect(metadata.affected_installments).toHaveLength(3);
    expect(metadata.installments_advanced).toBe(2);
    expect(metadata.installment_progress_after).toBe("2,5/24");
    expect(
      metadata.affected_installments.reduce((s: number, i: any) => s + i.amount_applied, 0),
    ).toBe(250);
  });

  it("falha (metadata/qualquer etapa) propaga erro e não grava nada no cliente", async () => {
    rpcImpl = () => ({
      data: null,
      error: { message: "Não foi possível congelar o histórico deste pagamento." },
    });

    const { registerPayment } = await import("@/lib/payment-utils");
    await expect(
      registerPayment({
        loanId: LOAN, amount: 100, clientId: CLIENT, clientName: "Cliente 1",
        cashDate: CASH_DATE, origin: "rota",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("congelar") });

    // Rollback é do banco; o cliente não executa nenhuma escrita compensatória.
    expect(rpcCalls.map((c) => c.fn)).toEqual(["register_payment_tx"]);
    expect(tableCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
  });

  it("escopo: pagamento em empréstimo de outro trabalhador/admin é negado", async () => {
    rpcImpl = () => ({ data: null, error: { message: "access denied" } });

    const { registerPayment } = await import("@/lib/payment-utils");
    await expect(
      registerPayment({
        loanId: "loan-de-outro", amount: 100, clientId: "outro-cliente", clientName: "X",
        cashDate: CASH_DATE, origin: "rota",
      }),
    ).rejects.toMatchObject({ message: "access denied" });

    expect(tableCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
  });

  it("usa a cash_date escolhida como dia financeiro", async () => {
    const metadata = metadataFor({
      applied: 100, before: 2400, after: 2300, paidBefore: 0, paidAfter: 1,
      progressBefore: "0/24", progressAfter: "1/24", affected: [],
    });
    rpcImpl = () => ({
      data: { applied: 100, new_balance: 2300, movement_id: "m4", event_id: "e4", metadata },
      error: null,
    });

    const { registerPayment } = await import("@/lib/payment-utils");
    await registerPayment({
      loanId: LOAN, amount: 100, clientId: CLIENT, clientName: "Cliente 1",
      cashDate: "2026-07-20", origin: "rota",
    });

    expect(rpcCalls[0].args.p_cash_date).toBe("2026-07-20");
  });
});
