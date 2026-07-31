import { describe, it, expect } from "vitest";
import {
  buildPaidGroupsFromFrozenEvents,
  findPaidGroupByMovement,
  removePaidGroupByMovement,
  type FrozenPaymentEvent,
  type LegacyPaymentMovement,
} from "@/lib/paid-groups";

const WORKER = "w1";
const ADMIN = "a1";
const DATE = "2026-07-31";

function ev(over: Partial<FrozenPaymentEvent> & { id: string }, md: Record<string, any> = {}): FrozenPaymentEvent {
  return {
    cash_date: DATE,
    event_type: "pagamento",
    client_id: "c1",
    loan_id: "l1",
    amount_in: 100,
    created_at: "2026-07-31T10:00:00.000Z",
    worker_id: WORKER,
    admin_id: ADMIN,
    metadata: {
      cash_movement_id: `mv-${over.id}`,
      client_name: "Cliente A",
      payment_amount: 100,
      remaining_balance_before: 2100,
      remaining_balance_after: 2000,
      installment_progress_before: "3/24",
      installment_progress_after: "4/24",
      progress_units_before: 3,
      progress_units_after: 4,
      installments_advanced: 1,
      installment_amount: 100,
      total_installments: 24,
      affected_installments: [{ installment_id: "i1", amount_applied: 100 }],
      ...md,
    },
    ...over,
  };
}

describe("buildPaidGroupsFromFrozenEvents", () => {
  it("mantém o progresso congelado do pagamento antigo após um pagamento posterior", () => {
    const groups = buildPaidGroupsFromFrozenEvents([
      ev({ id: "e1" }),
      ev(
        { id: "e2", created_at: "2026-07-31T12:00:00.000Z" },
        {
          remaining_balance_before: 2000,
          remaining_balance_after: 1900,
          installment_progress_before: "4/24",
          installment_progress_after: "5/24",
          progress_units_before: 4,
          progress_units_after: 5,
        },
      ),
    ], { cashDate: DATE, scope: { workerId: WORKER, adminId: ADMIN } });

    expect(groups).toHaveLength(2);
    expect(groups[0].progressBeforeFormatted).toBe("3/24");
    expect(groups[0].progressAfterFormatted).toBe("4/24");
    expect(groups[1].progressBeforeFormatted).toBe("4/24");
    // ordenados por created_at
    expect(new Date(groups[0].createdAt).getTime()).toBeLessThan(new Date(groups[1].createdAt).getTime());
    expect(groups[0].movementId).not.toBe(groups[1].movementId);
  });

  it("mantém progresso fracionado em pagamento parcial", () => {
    const [g] = buildPaidGroupsFromFrozenEvents([
      ev({ id: "e1", amount_in: 50 }, {
        payment_amount: 50,
        installment_progress_after: "3,5/24",
        progress_units_after: 3.5,
        installments_advanced: 0,
      }),
    ], { cashDate: DATE });

    expect(g.hasFrozenProgress).toBe(true);
    expect(g.progressAfterFormatted).toBe("3,5/24");
    expect(g.progressDeltaFormatted).toBe("+0,5");
    expect(g.totalPaid).toBe(50);
  });

  it("não inventa zeros quando o metadata está incompleto", () => {
    const [g] = buildPaidGroupsFromFrozenEvents([
      ev({ id: "e1" }, { installment_amount: undefined, affected_installments: undefined }),
    ], { cashDate: DATE });

    expect(g.hasFrozenProgress).toBe(false);
    expect(g.instAmount).toBeNull();
    expect(g.totalAmount).toBeNull();
    expect(g.installmentCount).toBeNull();
    expect(g.paidBefore).toBeNull();
    expect(g.paidAfter).toBeNull();
    expect(g.remainingBefore).toBeNull();
    expect(g.remainingAfter).toBeNull();
    expect(g.progressBeforeFormatted).toBeNull();
    expect(g.progressAfterFormatted).toBeNull();
    expect(g.progressDeltaFormatted).toBeNull();
    expect(g.installmentsAdvanced).toBeNull();
  });

  it("rejeita eventos com worker_id/admin_id ausente ou diferente", () => {
    const events = [
      ev({ id: "ok" }),
      ev({ id: "semWorker", worker_id: null }),
      ev({ id: "outroWorker", worker_id: "w2" }),
      ev({ id: "semAdmin", admin_id: null }),
      ev({ id: "outroAdmin", admin_id: "a2" }),
    ];
    const groups = buildPaidGroupsFromFrozenEvents(events, {
      cashDate: DATE,
      scope: { workerId: WORKER, adminId: ADMIN },
    });
    expect(groups.map((g) => g.eventId)).toEqual(["ok"]);
  });

  it("não duplica movimento já vinculado a um daily_event", () => {
    const legacy: LegacyPaymentMovement[] = [
      { id: "mv-e1", loan_id: "l1", amount: 100, created_at: "2026-07-31T10:00:00.000Z", cash_date: DATE, worker_id: WORKER, admin_id: ADMIN, daily_event_id: "e1" },
      { id: "mv-outro", loan_id: "l9", amount: 70, created_at: "2026-07-31T11:00:00.000Z", cash_date: DATE, worker_id: WORKER, admin_id: ADMIN, daily_event_id: "e9" },
      { id: "mv-legado", loan_id: "l8", amount: 60, created_at: "2026-07-31T09:00:00.000Z", cash_date: DATE, worker_id: WORKER, admin_id: ADMIN, daily_event_id: null },
    ];
    const groups = buildPaidGroupsFromFrozenEvents([ev({ id: "e1" })], {
      cashDate: DATE,
      scope: { workerId: WORKER, adminId: ADMIN },
      legacyMovements: legacy,
    });
    expect(groups.map((g) => g.movementId).sort()).toEqual(["mv-e1", "mv-legado"]);
    const legado = groups.find((g) => g.movementId === "mv-legado")!;
    expect(legado.hasFrozenProgress).toBe(false);
    expect(legado.eventId).toBeNull();
  });
});

describe("find/remove por movementId", () => {
  const groups = buildPaidGroupsFromFrozenEvents([
    ev({ id: "e1" }),
    ev({ id: "e2", created_at: "2026-07-31T12:00:00.000Z" }),
  ], { cashDate: DATE });

  it("localiza somente o pagamento escolhido", () => {
    expect(findPaidGroupByMovement(groups, "mv-e2")?.eventId).toBe("e2");
    expect(findPaidGroupByMovement(groups, "inexistente")).toBeUndefined();
  });

  it("remove somente o pagamento escolhido", () => {
    const rest = removePaidGroupByMovement(groups, "mv-e2");
    expect(rest.map((g) => g.movementId)).toEqual(["mv-e1"]);
  });
});
