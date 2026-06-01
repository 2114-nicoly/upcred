import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { computeDailyTotals } from "@/lib/daily-totals";

export type MovementDay = {
  date: string;                  // YYYY-MM-DD
  status: "open" | "closed" | null;
  entradas: number;
  saidas: number;
  saldo: number;
  eventsCount: number;
  notPaidCount: number;
  opening: number;
  expected: number;
  countedClosing: number | null;
  closingDifference: number | null;
};

type EventLike = {
  cash_date: string;
  event_type: string;
  amount_in: number | string;
  amount_out: number | string;
  reversed_at: string | null;
  worker_id: string | null;
  admin_id: string | null;
};

type CashLike = {
  cash_date: string;
  status: string;
  opening_balance: number | string | null;
  expected_closing_balance: number | string | null;
  counted_closing_balance: number | string | null;
  closing_difference: number | string | null;
  worker_id: string | null;
  admin_id: string | null;
};

export type UseMovementDaysOpts = {
  /** Limit to scope (admin filter view): only show events of this worker. */
  workerId?: string | null;
  /** Limit to admin scope (super-admin view). */
  adminId?: string | null;
  /** Limit lookback range (defaults to last 180 days). */
  fromDate?: string;
  toDate?: string;
};

const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function useMovementDays(opts: UseMovementDaysOpts = {}) {
  const { workerId = null, adminId = null } = opts;
  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(defaultFrom.getDate() - 180);
  const fromDate = opts.fromDate || fmt(defaultFrom);
  const toDate = opts.toDate || fmt(today);

  const [days, setDays] = useState<MovementDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let evQ: any = supabase
        .from("daily_events" as any)
        .select("cash_date,event_type,amount_in,amount_out,reversed_at,worker_id,admin_id")
        .gte("cash_date", fromDate)
        .lte("cash_date", toDate)
        .limit(5000);
      if (workerId) evQ = evQ.eq("worker_id", workerId);
      else if (adminId) evQ = evQ.eq("admin_id", adminId);

      let cashQ: any = supabase
        .from("daily_cash")
        .select("cash_date,status,opening_balance,expected_closing_balance,counted_closing_balance,closing_difference,worker_id,admin_id")
        .gte("cash_date", fromDate)
        .lte("cash_date", toDate);
      if (workerId) cashQ = cashQ.eq("worker_id", workerId);
      else if (adminId) cashQ = cashQ.eq("admin_id", adminId);

      const [{ data: evs, error: e1 }, { data: cashes, error: e2 }] = await Promise.all([evQ, cashQ]);
      if (e1) throw e1;
      if (e2) throw e2;

      const byDate = new Map<string, EventLike[]>();
      for (const e of ((evs as EventLike[]) || [])) {
        const k = e.cash_date;
        if (!byDate.has(k)) byDate.set(k, []);
        byDate.get(k)!.push(e);
      }
      const cashByDate = new Map<string, CashLike>();
      for (const c of ((cashes as CashLike[]) || [])) {
        cashByDate.set(c.cash_date, c);
      }

      const allDates = new Set<string>([...byDate.keys(), ...cashByDate.keys()]);
      const out: MovementDay[] = [];
      for (const date of allDates) {
        const events = byDate.get(date) || [];
        const cash = cashByDate.get(date) || null;
        const opening = Number(cash?.opening_balance || 0);
        const t = computeDailyTotals(events as any, opening);
        const status = (cash?.status === "closed" ? "closed" : cash?.status === "open" ? "open" : (events.length ? "open" : null)) as MovementDay["status"];
        const counted = cash?.counted_closing_balance != null ? Number(cash.counted_closing_balance) : null;
        const diff = cash?.closing_difference != null ? Number(cash.closing_difference) : null;
        // Only include days with actual movement OR an existing daily_cash row.
        if (events.length === 0 && !cash) continue;
        out.push({
          date,
          status,
          entradas: t.entradas,
          saidas: t.saidas,
          saldo: t.entradas - t.saidas,
          eventsCount: events.length,
          notPaidCount: t.naoPagos,
          opening,
          expected: cash?.expected_closing_balance != null ? Number(cash.expected_closing_balance) : t.saldoFinalEsperado,
          countedClosing: counted,
          closingDifference: diff,
        });
      }
      out.sort((a, b) => b.date.localeCompare(a.date));
      setDays(out);
    } catch (err: any) {
      console.error("[useMovementDays]", err);
      setError(err?.message || "Erro ao carregar dias com movimento");
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, workerId, adminId]);

  useEffect(() => { load(); }, [load]);

  return { days, loading, error, reload: load };
}
