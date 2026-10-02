import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePenaltyPaymentPlan, parsePenaltyInput } from "@/lib/penalty-payment";
import { buildPaidGroupsFromFrozenEvents, collectHandledLoanIds, type FrozenPaymentEvent } from "@/lib/paid-groups";

const page = readFileSync(resolve(process.cwd(), "src/pages/DailyCashPage.tsx"), "utf8");

describe("plano do pagamento com multa", () => {
  it("pagamento normal sem mudança quando multa = 0", () => {
    expect(resolvePenaltyPaymentPlan({ penaltyRaw: "", mode: null, regularAmount: 50 })).toEqual({ kind: "normal", regular: 50 });
    expect(resolvePenaltyPaymentPlan({ penaltyRaw: "0", mode: "penalty_only", regularAmount: 50 })).toEqual({ kind: "normal", regular: 50 });
  });
  it("exige escolha quando multa > 0", () => {
    expect(resolvePenaltyPaymentPlan({ penaltyRaw: "10", mode: null, regularAmount: 50 }).kind).toBe("needs_mode");
  });
  it("parcela + multa", () => {
    expect(resolvePenaltyPaymentPlan({ penaltyRaw: "10", mode: "regular_and_penalty", regularAmount: 50 }))
      .toEqual({ kind: "regular_and_penalty", regular: 50, penalty: 10 });
  });
  it("somente multa envia parcela 0", () => {
    expect(resolvePenaltyPaymentPlan({ penaltyRaw: "10,5", mode: "penalty_only", regularAmount: 50 }))
      .toEqual({ kind: "penalty_only", regular: 0, penalty: 10.5 });
  });
  it("multa inválida", () => {
    expect(parsePenaltyInput("-1")).toBeNull();
  });
});

const D = "2026-10-01";
const base = { cash_date: D, client_id: "c1", loan_id: "L1", created_at: "2026-10-01T12:00:00Z" };
const payEvt = (md: any): FrozenPaymentEvent => ({
  ...base, id: "e1", event_type: "pagamento", amount_in: 50, cash_movement_id: "m1",
  metadata: {
    client_name: "Ana", remaining_balance_before: 500, remaining_balance_after: 450,
    installment_progress_before: "0/10", installment_progress_after: "1/10",
    total_installments: 10, installment_amount: 50, payment_amount: 50,
    affected_installments: [{ installment_id: "i1" }], ...md,
  },
});
const penEvt = (md: any): FrozenPaymentEvent => ({
  ...base, id: "e2", event_type: "recebimento_multa", amount_in: 10, cash_movement_id: "m2",
  metadata: { client_name: "Ana", penalty_amount: 10, remaining_balance_before: 500, remaining_balance_after: 500, ...md },
});

describe("cards de Pagos do Dia", () => {
  it("parcela + multa vira um único card agrupado", () => {
    const op = { operation_id: "op1", payment_mode: "regular_and_penalty", regular_amount: 50, penalty_amount: 10, total_received: 60 };
    const groups = buildPaidGroupsFromFrozenEvents([payEvt(op), penEvt(op)], { cashDate: D });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ paymentMode: "regular_and_penalty", operationId: "op1", totalPaid: 60, penaltyAmount: 10, regularAmount: 50 });
  });
  it("somente multa vira card próprio sem progresso de parcela", () => {
    const groups = buildPaidGroupsFromFrozenEvents([penEvt({ operation_id: "op2", payment_mode: "penalty_only", total_received: 10 })], { cashDate: D });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ paymentMode: "penalty_only", regularAmount: 0, penaltyAmount: 10, hasFrozenProgress: false, remainingAfter: 500 });
    expect(groups[0].installmentIds).toEqual([]);
  });
  it("pagamento normal mantém card atual", () => {
    const groups = buildPaidGroupsFromFrozenEvents([payEvt({})], { cashDate: D });
    expect(groups[0].paymentMode).toBe("normal");
    expect(groups[0].operationId).toBeNull();
  });
});

describe("Pendentes", () => {
  const only = penEvt({ operation_id: "op2", payment_mode: "penalty_only" });
  it("somente multa retira o cliente apenas naquela data", () => {
    expect(collectHandledLoanIds([only], D).has("L1")).toBe(true);
  });
  it("volta no dia seguinte", () => {
    expect(collectHandledLoanIds([only], "2026-10-02").has("L1")).toBe(false);
  });
  it("multa estornada não retira", () => {
    expect(collectHandledLoanIds([{ ...only, reversed_at: "x" }], D).has("L1")).toBe(false);
  });
});

describe("DailyCashPage — ligação às RPCs", () => {
  it("não usa registerPenaltyPayment e chama a RPC única", () => {
    expect(page).not.toContain("registerPenaltyPayment");
    expect(page).toContain("registerRoutePaymentWithPenalty(");
  });
  it("bloqueia clique duplo", () => {
    expect(page).toMatch(/if \(isSubmitting \|\| payLockRef\.current\) return;/);
  });
  it("erro mantém o modal preenchido (reset só após sucesso)", () => {
    const body = page.slice(page.indexOf("const handlePay="), page.indexOf("const resetPayDialog"));
    const catchIdx = body.indexOf("catch (err");
    expect(body.indexOf("resetPayDialog()")).toBeLessThan(catchIdx);
    expect(body.slice(catchIdx)).not.toContain("resetPayDialog()");
  });
  it("estorno pelo operation_id", () => {
    expect(page).toContain("reverseRoutePaymentWithPenalty({ operationId: group.operationId })");
  });
});
