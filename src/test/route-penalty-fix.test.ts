import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeEvent, mergePenaltyOperations } from "@/lib/event-record";
import { computeDailyTotals } from "@/lib/daily-totals";

const MIG = resolve(process.cwd(), "supabase/migrations");
const sql = readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort().reverse()
  .map((f) => readFileSync(resolve(MIG, f), "utf8"))
  .find((s) => s.includes("FUNCTION public.register_route_payment_with_penalty_tx"))!;
const body = (n: string) => { const a = sql.indexOf(`FUNCTION public.${n}(`); return sql.slice(a, sql.indexOf("END $function$", a)); };
const reg = body("register_route_payment_with_penalty_tx");
const rev = body("reverse_route_payment_with_penalty_tx");
const page = readFileSync(resolve(process.cwd(), "src/pages/DailyCashPage.tsx"), "utf8");
const utils = readFileSync(resolve(process.cwd(), "src/lib/payment-utils.ts"), "utf8");
const loanPage = readFileSync(resolve(process.cwd(), "src/pages/LoanDetailPage.tsx"), "utf8");

describe("banco — idempotência e conferência", () => {
  it("repetição com mesmos dados devolve o resultado gravado; dados diferentes/estornada são rejeitados", () => {
    expect(reg).toContain("'idempotent', true");
    expect(reg).toContain("já foi usado com dados diferentes");
    expect(reg).toContain("já foi estornada e não pode ser reutilizada");
    expect(reg.indexOf("'idempotent', true")).toBeLessThan(reg.indexOf("register_payment_tx("));
  });
  it("confere parcela agregada x penalties e distribuição completa", () => {
    expect(reg).toContain("Multas deste empréstimo estão divergentes");
    expect(reg).toMatch(/IF v_left > 0\.005 THEN\s+RAISE EXCEPTION/);
    expect(reg).not.toMatch(/EXCEPTION\s+WHEN/);
  });
  it("exige parcela em aberto e saldo", () => {
    expect(reg).toContain("v_inst.status NOT IN ('pending','partial','overdue')");
    expect(reg).toContain("remaining_balance, 0) <= 0.01");
  });
  it("congela snapshot da parcela de multa e linhas de penalties", () => {
    expect(reg).toContain("'penalty_installment_snapshot', v_pen_snapshot");
    expect(reg).toContain("'amount_before', r.amount");
  });
  it("estorno restaura exatamente o snapshot e cancela multa criada", () => {
    expect(rev).toContain("status = v_snap->>'status'");
    expect(rev).toContain("paid_at = NULLIF(v_snap->>'paid_at','')::timestamptz");
    expect(rev).toContain("Uma multa antiga foi alterada depois desta operação");
    expect(rev).toContain("cancelled_at = now()");
    expect(rev).toContain("existe uma operação posterior");
    expect(rev).toMatch(/dc\.status = 'open'/);
  });
});

describe("frontend — operation_id estável e estorno do conjunto", () => {
  it("mesmo operation_id na repetição da mesma tentativa; reset só após sucesso", () => {
    expect(page).toContain("payOpRef.current.sig !== sig");
    expect(page).toMatch(/const resetPayDialog = \(\) => \{\s+payOpRef\.current = null;/);
  });
  it("reversePayment estorna a operação inteira pela RPC", () => {
    expect(utils).toContain("findPenaltyOperationForMovement(movementId)");
    expect(utils).toContain("reverseRoutePaymentWithPenalty({ operationId: op.operationId, reason })");
  });
});

const base = { cash_date: "2026-10-01", created_at: "2026-10-01T12:00:00Z", client_id: "c1", loan_id: "L1" };
const op = { operation_id: "op1", payment_mode: "regular_and_penalty", regular_amount: 100, penalty_amount: 20, total_received: 120 };
const regEv = { ...base, id: "r", event_type: "pagamento", amount_in: 100, reversed_at: null, reverses_event_id: null, metadata: { ...op, client_name: "Ana", payment_amount: 100, remaining_balance_before: 500, remaining_balance_after: 400 } };
const penEv = { ...base, id: "p", event_type: "recebimento_multa", amount_in: 20, reversed_at: null, reverses_event_id: null, metadata: { ...op, client_name: "Ana", remaining_balance_before: 500, remaining_balance_after: 400 } };

describe("históricos — uma operação, totais intactos", () => {
  it("parcela 100 + multa 20 vira um registro de 120 e totais continuam separados", () => {
    const merged = mergePenaltyOperations([normalizeEvent(regEv as any), normalizeEvent(penEv as any)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("Pagou parcela + multa");
    expect(merged[0].amountIn).toBe(120);
    const txt = JSON.stringify(merged[0]);
    for (const v of ["Ana", "100,00", "20,00", "120,00", "500,00", "400,00"]) expect(txt).toContain(v);
    const t = computeDailyTotals([regEv, penEv] as any);
    expect(t.pagamentos).toBe(100);
    expect(t.multas).toBe(20);
    expect(t.entradas).toBe(120);
  });
  it("somente multa permanece um registro de 20", () => {
    const only = { ...penEv, metadata: { ...penEv.metadata, payment_mode: "penalty_only", regular_amount: 0, total_received: 20 } };
    const merged = mergePenaltyOperations([normalizeEvent(only as any)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].amountIn).toBe(20);
  });
  it("operações diferentes não se misturam", () => {
    const other = { ...regEv, id: "x", metadata: { ...regEv.metadata, operation_id: "op2" } };
    expect(mergePenaltyOperations([normalizeEvent(regEv as any), normalizeEvent(penEv as any), normalizeEvent(other as any)])).toHaveLength(2);
  });
});

describe("Multas pagas no detalhe do empréstimo", () => {
  const sumPaid = (movs: { amount: number; reversed_at: string | null; type: string }[]) =>
    movs.filter((m) => m.type === "recebimento_multa" && !m.reversed_at).reduce((s, m) => s + m.amount, 0);
  it("20 + 15 e estorno de 15 => 20; sem multas => 0", () => {
    expect(sumPaid([
      { type: "recebimento_multa", amount: 20, reversed_at: null },
      { type: "recebimento_multa", amount: 15, reversed_at: "x" },
      { type: "estorno_pagamento", amount: -15, reversed_at: null },
    ])).toBe(20);
    expect(sumPaid([])).toBe(0);
  });
  it("tela consulta só recebimentos de multa do próprio contrato não estornados e sempre exibe a linha", () => {
    expect(loanPage).toContain('.eq("loan_id", loanId!).eq("type", "recebimento_multa").is("reversed_at", null)');
    expect(loanPage).toContain("Multas pagas:");
    expect(loanPage).not.toContain(">Multa paga:<");
  });
});
