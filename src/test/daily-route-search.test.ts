import { describe, it, expect } from "vitest";
import {
  buildDailyRouteSearchIndex,
  filterRouteSearchIndex,
  groupRouteSearchResults,
  normalizeSearchText,
} from "@/lib/daily-route-search";

const DATE = "2026-08-10";
const SCOPE = { workerId: "w1", adminId: "a1" };

const paidGroup = (over: Partial<any> = {}) => ({
  eventId: "ev-pay-1",
  movementId: "mov-1",
  clientId: "c1",
  clientName: "José Antônio",
  loanId: "l1",
  totalPaid: 150,
  createdAt: "2026-08-10T10:00:00.000Z",
  cashDate: DATE,
  progressBeforeFormatted: "3/10",
  progressAfterFormatted: "6/10",
  ...over,
});

const event = (over: Partial<any> = {}) => ({
  id: "ev-1",
  cash_date: DATE,
  event_type: "pagamento",
  client_id: "c1",
  loan_id: "l1",
  installment_id: null,
  cash_movement_id: "mov-1",
  amount_in: 150,
  amount_out: 0,
  observation: null,
  created_at: "2026-08-10T10:00:00.000Z",
  worker_id: "w1",
  admin_id: "a1",
  ...over,
});

describe("buildDailyRouteSearchIndex", () => {
  it("mantém cliente pago pesquisável mesmo fora dos pendentes", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE,
      scope: SCOPE,
      pendingInstallments: [],
      paidGroups: [paidGroup()],
    });
    const found = filterRouteSearchIndex(index, "jose");
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("Pago");
    expect(found[0].description).toContain("3/10 → 6/10");
    expect(found[0].status).toBe("done");
  });

  it("encontra cliente marcado como Não pagou", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE,
      scope: SCOPE,
      notPaidMarks: [{
        id: "np-1", mark_date: DATE, installment_id: "i1", loan_id: "l1",
        client_id: "c2", observation: "[Sem dinheiro] voltar amanhã",
        created_at: "2026-08-10T11:00:00.000Z", worker_id: "w1", admin_id: "a1",
      }],
      clientNames: { c2: "Maria Silva" },
    });
    const found = filterRouteSearchIndex(index, "maria");
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("Não pagou");
    expect(found[0].description).toContain("Sem dinheiro");
  });

  it("encontra renovação do dia", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE,
      scope: SCOPE,
      newLoans: [{
        id: "l2", amount: 1000, total_amount: 1300, remaining_balance: 1300,
        status: "active", installment_count: 20, payment_type: "daily", loan_date: DATE,
        renewed_from_loan_id: "l1", clients: { id: "c1", name: "José Antônio" },
        worker_id: "w1", admin_id: "a1",
      }],
      renewalEvents: [event({ id: "ev-ren", event_type: "renovacao", loan_id: "l2", amount_in: 0, amount_out: 400 })],
    });
    const found = filterRouteSearchIndex(index, "josé");
    expect(found.some((r) => r.label === "Renovação")).toBe(true);
    expect(found.find((r) => r.label === "Renovação")!.amount).toBe(400);
  });

  it("mostra duas ações do mesmo cliente no mesmo dia", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE,
      scope: SCOPE,
      paidGroups: [paidGroup()],
      events: [
        event(),
        event({ id: "ev-multa", event_type: "recebimento_multa", cash_movement_id: "mov-2", amount_in: 20, created_at: "2026-08-10T12:00:00.000Z" }),
      ],
      clientNames: { c1: "José Antônio" },
    });
    const groups = groupRouteSearchResults(filterRouteSearchIndex(index, "jose"));
    expect(groups).toHaveLength(1);
    expect(groups[0].results).toHaveLength(2);
    expect(groups[0].results.map((r) => r.label)).toEqual(["Pago", "Multa recebida"]);
  });

  it("não duplica pagamento presente em paidGroups e daily_events", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE,
      scope: SCOPE,
      paidGroups: [paidGroup()],
      events: [event()],
    });
    expect(index.filter((r) => r.action === "pagamento")).toHaveLength(1);
  });

  it("dia fechado usa somente o snapshot fornecido", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE,
      scope: SCOPE,
      paidGroups: [paidGroup({ clientName: "Cliente Congelado" })],
      events: [],
      clientNames: { c1: "Cliente Congelado" },
      readOnly: true,
    });
    expect(index).toHaveLength(1);
    expect(index[0].clientName).toBe("Cliente Congelado");
    expect(index.every((r) => r.status !== "pending")).toBe(true);
  });

  it("ignora dados de outro worker_id ou admin_id", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE,
      scope: SCOPE,
      events: [
        event({ id: "ev-other-worker", event_type: "despesa", worker_id: "w2", amount_out: 50 }),
        event({ id: "ev-other-admin", event_type: "despesa", admin_id: "a2", amount_out: 50 }),
      ],
      clientNames: { c1: "José Antônio" },
    });
    expect(index).toHaveLength(0);
  });

  it("busca funciona sem acentos e ignorando maiúsculas", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE, scope: SCOPE, paidGroups: [paidGroup({ clientName: "JOSÉ ANTÔNIO" })],
    });
    expect(filterRouteSearchIndex(index, "jose antonio")).toHaveLength(1);
    expect(filterRouteSearchIndex(index, "ANTÔNIO")).toHaveLength(1);
    expect(normalizeSearchText("Ção")).toBe("cao");
  });

  it("marca eventos estornados como estornados", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE,
      scope: SCOPE,
      reversedEvents: [event({ id: "ev-rev", reversed_at: "2026-08-10T13:00:00.000Z" })],
      clientNames: { c1: "José Antônio" },
    });
    const found = filterRouteSearchIndex(index, "jose");
    expect(found[0].status).toBe("reversed");
    expect(found[0].label).toBe("Pagamento estornado");
  });

  it("resultados pendentes são os únicos com status pending", () => {
    const index = buildDailyRouteSearchIndex({
      cashDate: DATE,
      scope: SCOPE,
      pendingInstallments: [{
        id: "i9", number: 4, amount: 50, due_date: DATE, status: "pending", loan_id: "l9",
        loans: { id: "l9", client_id: "c9", installment_count: 10, clients: { id: "c9", name: "Ana" } },
      }],
      paidGroups: [paidGroup()],
    });
    const pend = index.filter((r) => r.status === "pending");
    expect(pend).toHaveLength(1);
    expect(pend[0].clientName).toBe("Ana");
  });
});
