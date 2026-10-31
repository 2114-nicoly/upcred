import { describe, expect, it } from "vitest";
import { renewalPendingInterest } from "@/pages/NewLoanPage";

describe("juros pendentes na renovação — apropriação juros-primeiro", () => {
  it("oferece apenas os juros integralmente pendentes, não o contrato inteiro", () => {
    expect(renewalPendingInterest({ amount: 1000, total_amount: 1200, remaining_balance: 1200 })).toBe(200);
  });
  it("desconta pagamentos parciais, inclusive fração de uma parcela", () => {
    expect(renewalPendingInterest({ amount: 1000, total_amount: 1200, remaining_balance: 1125.5 })).toBe(125.5);
  });
  it("retorna zero quando os juros estão quitados e ainda há principal pendente", () => {
    expect(renewalPendingInterest({ amount: 1000, total_amount: 1200, remaining_balance: 950 })).toBe(0);
  });
  it("não confunde juros contratados com saldo pendente nem inclui multas", () => {
    const loan = { amount: "1000.00", total_amount: "1200.00", remaining_balance: "1150.00", penalty_amount: 60 };
    expect(renewalPendingInterest(loan)).toBe(150);
  });
  it("juros inexistentes não geram pagamento fictício", () => {
    expect(renewalPendingInterest({ amount: 1000, total_amount: 1000, remaining_balance: 1000 })).toBe(0);
  });
  it("não inventa saldo em dados ausentes, inválidos ou inconsistentes", () => {
    for (const remaining_balance of [null, undefined, "", "inválido", NaN, Infinity, -1, 1300]) {
      expect(renewalPendingInterest({ amount: 1000, total_amount: 1200, remaining_balance })).toBeNull();
    }
  });
  it("importados com bases contábeis divergentes ficam indisponíveis", () => {
    expect(renewalPendingInterest({ amount: 1000, total_amount: 1200, remaining_balance: 1050, is_imported_ongoing: true, initial_remaining_balance: 1100, amount_already_paid: 100 })).toBeNull();
  });
  it("importados com juros quitados nas duas bases podem mostrar zero", () => {
    expect(renewalPendingInterest({ amount: 1000, total_amount: 1200, remaining_balance: 800, is_imported_ongoing: true, initial_remaining_balance: 1100, amount_already_paid: 100 })).toBe(0);
  });
});