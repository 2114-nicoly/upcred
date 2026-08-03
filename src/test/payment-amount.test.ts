import { describe, it, expect } from "vitest";
import {
  createPaymentAmountState,
  computePaymentAmount,
  parseAmountInput,
  describeManualAmount,
  validatePaymentAmount,
} from "@/lib/payment-amount";

describe("payment-amount", () => {
  it("quantidade multiplica o valor CHEIO da parcela (ignora saldo pendente)", () => {
    const s = { ...createPaymentAmountState(), quantity: 3 };
    expect(computePaymentAmount(s, 100)).toBe(300);
  });

  it("aceita vírgula e ponto no modo manual", () => {
    expect(parseAmountInput("125,50")).toBe(125.5);
    expect(parseAmountInput("125.50")).toBe(125.5);
    expect(parseAmountInput("1.250,00")).toBe(1250);
    expect(parseAmountInput("abc")).toBeNull();
  });

  it("mostra equivalência em parcelas para valores quebrados", () => {
    const d = describeManualAmount(225, 100);
    expect(d.fullCount).toBe(2);
    expect(d.rest).toBe(25);
    expect(d.isBroken).toBe(true);
  });

  it("bloqueia total acima do saldo devedor", () => {
    const s = { ...createPaymentAmountState(), quantity: 5 };
    expect(validatePaymentAmount(s, 100, 300).valid).toBe(false);
    expect(validatePaymentAmount({ ...s, quantity: 3 }, 100, 300).valid).toBe(true);
  });

  it("rejeita valor zero", () => {
    const s = { ...createPaymentAmountState(), mode: "manual" as const, manualValue: "0" };
    expect(validatePaymentAmount(s, 100, 1000).valid).toBe(false);
  });
});
