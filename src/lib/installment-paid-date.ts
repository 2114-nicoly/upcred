/**
 * Resolve a data financeira real em que uma parcela ficou totalmente paga.
 *
 * Fonte principal: daily_events de pagamento (não estornados) cujo
 * metadata.affected_installments contém a parcela com status_after = "paid"
 * e amount_applied > 0. Usa event.cash_date (data financeira congelada).
 *
 * Fallback legado: installments.paid_at (registros antigos sem metadata).
 * Sem fonte confiável → null (nunca inferir due_date ou data atual).
 */
export type PaidDateEvent = {
  event_type?: string | null;
  cash_date: string;
  created_at?: string | null;
  reversed_at?: string | null;
  metadata?: Record<string, any> | null;
};

export function resolveInstallmentPaidDate(
  installment: { id: string; paid_at?: string | null },
  events: PaidDateEvent[] | null | undefined,
): string | null {
  const valid = (events || []).filter(
    (ev) => ev && !ev.reversed_at && (ev.event_type ?? "pagamento") === "pagamento",
  );

  const matches = valid.filter((ev) => {
    const affected = (ev.metadata as any)?.affected_installments;
    if (!Array.isArray(affected)) return false;
    return affected.some(
      (a: any) =>
        a &&
        a.installment_id === installment.id &&
        a.status_after === "paid" &&
        Number(a.amount_applied ?? 0) > 0,
    );
  });

  if (matches.length > 0) {
    // O evento mais recente que deixou a parcela paga é a quitação válida.
    const sorted = [...matches].sort((a, b) => {
      const da = a.cash_date.localeCompare(b.cash_date);
      if (da !== 0) return da;
      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    });
    return sorted[sorted.length - 1].cash_date;
  }

  // Fallback legado
  if (installment.paid_at) return installment.paid_at.slice(0, 10);
  return null;
}

/** Formata a data resolvida (YYYY-MM-DD) em DD/MM/AAAA, ou texto de indisponibilidade. */
export function formatPaidDateLabel(date: string | null): string {
  if (!date) return "data não disponível";
  const [y, m, d] = date.slice(0, 10).split("-");
  if (!y || !m || !d) return "data não disponível";
  return `${d}/${m}/${y}`;
}
