import { describe, it, expect } from "vitest";
import { normalizeMoney } from "@/lib/money";
import { formatCurrency } from "@/lib/loan-utils";
import { parseCashInsufficient, reportFinancialError, registerCashGuardHandler } from "@/lib/cash-guard";

const pgError = (available: number, operation: number, missing: number) => ({
  message: `Saldo insuficiente no caixa. Caixa disponível atual: R$ ${available.toFixed(2)}. Valor da operação: R$ ${Math.abs(operation).toFixed(2)}. Faltam: R$ ${missing.toFixed(2)}.`,
  hint: "CASH_INSUFFICIENT",
  details: JSON.stringify({
    code: "CASH_INSUFFICIENT",
    available_cash: available,
    operation_amount: operation,
    missing_amount: missing,
  }),
});

describe("normalizeMoney", () => {
  it("-0,001 vira zero", () => expect(normalizeMoney(-0.001)).toBe(0));
  it("-0 nunca sobrevive", () => expect(Object.is(normalizeMoney(-0), 0)).toBe(true));
  it("valor inválido vira zero", () => {
    expect(normalizeMoney(NaN)).toBe(0);
    expect(normalizeMoney(null)).toBe(0);
    expect(normalizeMoney("abc")).toBe(0);
  });
  it("negativo real não é escondido", () => expect(normalizeMoney(-12.345)).toBe(-12.35));
  it("arredonda para duas casas", () => expect(normalizeMoney(10.006)).toBe(10.01));
});

describe("formatCurrency", () => {
  const clean = (s: string) => s.replace(/\u00a0/g, " ");
  it("nunca exibe -R$ 0,00 nem R$ -0,00", () => {
    expect(clean(formatCurrency(-0.001))).toBe("R$ 0,00");
    expect(clean(formatCurrency(-0))).toBe("R$ 0,00");
    expect(clean(formatCurrency(NaN as any))).toBe("R$ 0,00");
  });
  it("mostra negativo real", () => {
    expect(clean(formatCurrency(-200))).toContain("-");
  });
});

describe("CASH_INSUFFICIENT", () => {
  it("saldo 500, empréstimo 700: faltam 200", () => {
    const info = parseCashInsufficient(pgError(500, -700, 200))!;
    expect(info.available_cash).toBe(500);
    expect(info.operation_amount).toBe(700);
    expect(info.missing_amount).toBe(200);
  });

  it("saldo zero, retirada 1: faltam 1", () => {
    const info = parseCashInsufficient(pgError(0, -1, 1))!;
    expect(info.missing_amount).toBe(1);
  });

  it("estorno com saldo insuficiente também é detectado", () => {
    const info = parseCashInsufficient(pgError(50, -200, 150))!;
    expect(info.code).toBe("CASH_INSUFFICIENT");
  });

  it("funciona sem DETAIL estruturado (fallback pela mensagem)", () => {
    const { details, ...noDetail } = pgError(500, -700, 200) as any;
    const info = parseCashInsufficient(noDetail)!;
    expect(info.available_cash).toBe(500);
    expect(info.missing_amount).toBe(200);
  });

  it("erros comuns não são tratados como saldo insuficiente", () => {
    expect(parseCashInsufficient({ message: "Caixa fechado para esta data" })).toBeNull();
    expect(parseCashInsufficient(null)).toBeNull();
  });

  it("reportFinancialError abre o modal com o escopo da operação recusada", () => {
    const calls: any[] = [];
    registerCashGuardHandler((r) => calls.push(r));
    const handled = reportFinancialError(pgError(500, -700, 200), {
      scope: { workerId: "w1", adminId: "a1" },
    });
    expect(handled).toBe(true);
    expect(calls[0].scope).toEqual({ workerId: "w1", adminId: "a1" });
    expect(calls[0].info.missing_amount).toBe(200);
    registerCashGuardHandler(null);
  });

  it("reportFinancialError devolve false para erros genéricos (toast normal)", () => {
    expect(reportFinancialError(new Error("falha de rede"))).toBe(false);
  });
});
