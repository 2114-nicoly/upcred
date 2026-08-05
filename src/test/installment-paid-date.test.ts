import { describe, it, expect } from "vitest";
import { resolveInstallmentPaidDate, formatPaidDateLabel } from "@/lib/installment-paid-date";

const ev = (cash_date: string, affected: any[], extra: any = {}) => ({
  event_type: "pagamento",
  cash_date,
  created_at: `${cash_date}T10:00:00Z`,
  reversed_at: null,
  metadata: { affected_installments: affected },
  ...extra,
});

describe("resolveInstallmentPaidDate", () => {
  it("1. três parcelas quitadas pelo mesmo pagamento têm a mesma data", () => {
    const events = [ev("2026-08-05", [
      { installment_id: "i4", status_after: "paid", amount_applied: 35 },
      { installment_id: "i5", status_after: "paid", amount_applied: 35 },
      { installment_id: "i6", status_after: "paid", amount_applied: 35 },
    ])];
    for (const id of ["i4", "i5", "i6"]) {
      expect(resolveInstallmentPaidDate({ id }, events)).toBe("2026-08-05");
    }
  });

  it("3. parcial dia 01 + quitação dia 05 → 05", () => {
    const events = [
      ev("2026-08-01", [{ installment_id: "i1", status_after: "partial", amount_applied: 10 }]),
      ev("2026-08-05", [{ installment_id: "i1", status_after: "paid", amount_applied: 25 }]),
    ];
    expect(resolveInstallmentPaidDate({ id: "i1" }, events)).toBe("2026-08-05");
  });

  it("4. evento estornado é ignorado", () => {
    const events = [
      ev("2026-08-01", [{ installment_id: "i1", status_after: "paid", amount_applied: 35 }], { reversed_at: "2026-08-02T00:00:00Z" }),
      ev("2026-08-06", [{ installment_id: "i1", status_after: "paid", amount_applied: 35 }]),
    ];
    expect(resolveInstallmentPaidDate({ id: "i1" }, events)).toBe("2026-08-06");
  });

  it("5. registro antigo sem metadata usa paid_at", () => {
    expect(resolveInstallmentPaidDate({ id: "i1", paid_at: "2026-07-16T13:20:00Z" }, [])).toBe("2026-07-16");
  });

  it("6. sem fonte confiável retorna null / rótulo indisponível", () => {
    expect(resolveInstallmentPaidDate({ id: "i1" }, [])).toBeNull();
    expect(formatPaidDateLabel(null)).toBe("data não disponível");
    expect(formatPaidDateLabel("2026-08-05")).toBe("05/08/2026");
  });

  it("ignora amount_applied zero", () => {
    const events = [ev("2026-08-05", [{ installment_id: "i1", status_after: "paid", amount_applied: 0 }])];
    expect(resolveInstallmentPaidDate({ id: "i1" }, events)).toBeNull();
  });
});
