import { describe, it, expect } from "vitest";
import { buildRenewalCardValues } from "@/pages/DailyCashPage";

/**
 * O card "Renovações do Dia" deve usar SOMENTE os campos numéricos de
 * daily_event.metadata. A "observation" é texto livre gravado pelo banco no
 * formato "Pago: R$ 325.00" — reler esse texto como número brasileiro
 * (removendo pontos) transformaria 325,00 em 32.500.
 */

const OBSERVATION =
  "Renovação - Maria - Pago: R$ 325.00 | Faltava: R$ 325.00 | Novo: R$ 500.00 | Liberado: R$ 500.00";

function evt(over: Record<string, any> = {}) {
  return {
    amount_out: 0,
    observation: OBSERVATION,
    metadata: {
      renew_paid_amount: "325.00",
      old_remaining_before: "325.00",
      renew_additional_cash: "500.00",
      renew_absorbed_amount: "0.00",
    },
    ...over,
  };
}

describe("buildRenewalCardValues (Rota — Renovações do Dia)", () => {
  it("lê '325.00' do metadata como 325 e nunca como 32500", () => {
    const values = buildRenewalCardValues(evt(), { amount: "500.00" });
    expect(values.paid).toBe(325);
    expect(values.faltava).toBe(325);
    expect(values.newAmount).toBe(500);
    expect(values.released).toBe(500);
    expect(values.absorbed).toBe(0);
  });

  it("ignora completamente a observation: sem metadata, nada é extraído do texto", () => {
    const values = buildRenewalCardValues(
      { amount_out: 0, observation: OBSERVATION, metadata: null },
      { amount: 500 },
    );
    expect(values.paid).toBe(0);
    expect(values.faltava).toBe(0);
    expect(values.released).toBe(0); // sem metadata, vale o amount_out do evento
    expect(values.newAmount).toBe(500);
  });

  it("sem evento de renovação, o liberado vem do valor do novo empréstimo", () => {
    expect(buildRenewalCardValues(null, { amount: "500.00" }).released).toBe(500);
  });

  it("usa a cadeia de fallback do valor liberado", () => {
    expect(
      buildRenewalCardValues(
        evt({ metadata: { released_amount: "120.00" }, amount_out: 999 }),
        { amount: 500 },
      ).released,
    ).toBe(120);
    expect(
      buildRenewalCardValues(evt({ metadata: {}, amount_out: "80.50" }), { amount: 500 }).released,
    ).toBe(80.5);
  });

  it("rejeita valores não numéricos e negativos", () => {
    const values = buildRenewalCardValues(
      evt({
        amount_out: -10,
        metadata: {
          renew_paid_amount: "abc",
          old_remaining_before: -50,
          renew_absorbed_amount: null,
        },
      }),
      { amount: 500 },
    );
    expect(values.paid).toBe(0);
    expect(values.faltava).toBe(0);
    expect(values.absorbed).toBe(0);
    expect(values.released).toBe(500);
  });

  it("mantém decimais reais sem multiplicar por 100", () => {
    const values = buildRenewalCardValues(
      evt({
        metadata: {
          renew_paid_amount: "1234.56",
          old_remaining_before: 7.5,
          renew_additional_cash: 1000.05,
        },
      }),
      { amount: 1500 },
    );
    expect(values.paid).toBe(1234.56);
    expect(values.faltava).toBe(7.5);
    expect(values.released).toBe(1000.05);
  });
});
