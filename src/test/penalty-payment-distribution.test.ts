import { describe, it, expect, vi } from "vitest";
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import { planPenaltyDistribution, PenaltyRow } from "@/lib/payment-utils";

const rows = (): PenaltyRow[] => [
  { id: "a", amount: 30, paid_amount: 0, paid: false, paid_at: null, created_at: "2026-01-01" },
  { id: "b", amount: 20, paid_amount: 0, paid: false, paid_at: null, created_at: "2026-01-02" },
];
const pending = (r: PenaltyRow[]) => r.reduce((s, x) => s + x.amount - x.paid_amount, 0);

describe("pagamento de multa pelo Detalhe do Empréstimo", () => {
  it("30+20, paga 35: distribui em ordem e sincroniza agregada", () => {
    const r = rows();
    const agg = { amount: 50, paid_amount: 0 };
    const plan = planPenaltyDistribution(r, 35, agg.amount - agg.paid_amount, "2026-10-02");
    for (const u of plan.updates) Object.assign(r.find((x) => x.id === u.id)!, u);
    agg.paid_amount += 35;
    expect(r[0]).toMatchObject({ paid_amount: 30, paid: true });
    expect(r[0].paid_at).not.toBeNull();
    expect(r[1]).toMatchObject({ paid_amount: 5, paid: false, paid_at: null });
    expect(pending(r)).toBe(15);
    expect(agg.amount - agg.paid_amount).toBe(15);
    // Validação da Rota: agregada × penalties sem divergência
    expect(Math.abs(pending(r) - (agg.amount - agg.paid_amount))).toBeLessThanOrEqual(0.01);
    expect(() => planPenaltyDistribution(r, 15, 15, "2026-10-02")).not.toThrow();
  });

  it("rejeita valor maior que o pendente sem alteração parcial", () => {
    const r = rows();
    const before = JSON.stringify(r);
    expect(() => planPenaltyDistribution(r, 60, 50, "2026-10-02")).toThrow(/maior que a multa pendente/);
    expect(JSON.stringify(r)).toBe(before);
  });

  it("rejeita quando agregada diverge das penalties", () => {
    expect(() => planPenaltyDistribution(rows(), 10, 30, "2026-10-02")).toThrow(/inconsistentes/);
  });
});
