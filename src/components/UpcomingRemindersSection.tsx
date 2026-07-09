import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format, differenceInCalendarDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bell, BellRing, MessageCircle, Eye, CalendarClock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/loan-utils";
import { logAction } from "@/lib/audit-utils";
import {
  getReminderDays,
  getReminderMark,
  saveReminderMark,
  type ReminderMark,
} from "@/lib/reminders";

type Row = {
  id: string;
  number: number;
  amount: number;
  due_date: string;
  status: string;
  loan_id: string;
  loans: {
    id: string;
    worker_id: string | null;
    payment_type: string;
    client_id: string;
    remaining_balance: number;
    status: string;
    clients: { id: string; name: string; phone: string | null } | null;
  } | null;
};

type Props = {
  workerId: string | null;
  adminId: string | null;
};

const TARGET_TYPES = ["monthly", "fixed_dates"];

function paymentLabel(t: string) {
  if (t === "monthly") return "Mensal";
  if (t === "fixed_dates") return "Data Fixa";
  return t;
}

export default function UpcomingRemindersSection({ workerId, adminId }: Props) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[]>([]);
  const [marks, setMarks] = useState<Record<string, ReminderMark | null>>({});
  const [days, setDays] = useState<number>(getReminderDays(workerId));
  const [loading, setLoading] = useState(true);

  // Refresh preferred days when worker changes
  useEffect(() => { setDays(getReminderDays(workerId)); }, [workerId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const from = new Date(today); from.setDate(from.getDate() + 1);
      const to = new Date(today); to.setDate(to.getDate() + days);
      const fromStr = format(from, "yyyy-MM-dd");
      const toStr = format(to, "yyyy-MM-dd");

      let query = supabase
        .from("installments")
        .select(
          "id, number, amount, due_date, status, loan_id, loans!inner(id, worker_id, payment_type, client_id, remaining_balance, status, clients(id, name, phone))"
        )
        .gte("due_date", fromStr)
        .lte("due_date", toStr)
        .not("status", "in", "(paid,cancelled,renegotiated)")
        .in("loans.payment_type", TARGET_TYPES)
        .not("loans.status", "in", "(paid,cancelled,renegotiated)")
        .gt("loans.remaining_balance", 0.01)
        .order("due_date", { ascending: true });

      if (workerId) query = query.eq("loans.worker_id", workerId);

      const { data, error } = await query;
      if (error) {
        console.warn("[upcoming] fetch failed", error);
        setRows([]);
      } else {
        const list = ((data as unknown) as Row[] || []).filter(r => r.loans && r.loans.clients);
        setRows(list);
        const m: Record<string, ReminderMark | null> = {};
        for (const r of list) m[r.id] = getReminderMark(r.id);
        setMarks(m);
      }
    } finally {
      setLoading(false);
    }
    void adminId;
  }, [workerId, adminId, days]);

  useEffect(() => { void load(); }, [load]);

  function onChangeDays(v: string) {
    const n = Number(v);
    if (![2, 3, 4, 5].includes(n)) return;
    setDays(n);
    try { localStorage.setItem(`upcoming_reminder_days:${workerId || "global"}`, String(n)); } catch { /* noop */ }
  }

  function openWhats(r: Row) {
    const client = r.loans?.clients;
    if (!client) return;
    const nome = client.name;
    const valor = formatCurrency(Number(r.amount));
    const data = format(new Date(r.due_date + "T12:00:00"), "dd/MM/yyyy");
    const msg = `Olá, ${nome}. Passando para lembrar que sua parcela de ${valor} vence em ${data}. Qualquer dúvida estou à disposição.`;
    const phone = (client.phone || "").replace(/\D/g, "");
    const url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    window.open(url, "_blank");
  }

  async function markReminded(r: Row) {
    const now = new Date().toISOString();
    const mark: ReminderMark = {
      installment_id: r.id,
      loan_id: r.loan_id,
      client_id: r.loans?.client_id ?? null,
      worker_id: workerId,
      at: now,
    };
    saveReminderMark(mark);
    setMarks(prev => ({ ...prev, [r.id]: mark }));
    // Best-effort audit; never blocks UI.
    try {
      await logAction(
        "editar_observacao_emprestimo",
        "installment",
        r.id,
        null,
        {
          event: "reminder_sent",
          installment_id: r.id,
          loan_id: r.loan_id,
          client_id: r.loans?.client_id ?? null,
          worker_id: workerId,
          due_date: r.due_date,
          amount: Number(r.amount),
          at: now,
        },
        "Lembrete de cobrança enviado",
        workerId,
      );
    } catch { /* noop */ }
    toast.success("Lembrete registrado");
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);

  return (
    <div className="space-y-2 mb-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-foreground flex items-center gap-1 uppercase tracking-wider">
          <CalendarClock className="h-3 w-3" /> Próximas Cobranças ({rows.length})
        </h2>
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-muted-foreground">Lembrar</label>
          <select
            value={String(days)}
            onChange={(e) => onChangeDays(e.target.value)}
            className="text-[11px] border border-border bg-card rounded-md px-1.5 py-0.5"
            aria-label="Antecedência do lembrete"
          >
            <option value="2">2 dias antes</option>
            <option value="3">3 dias antes</option>
            <option value="4">4 dias antes</option>
            <option value="5">5 dias antes</option>
          </select>
        </div>
      </div>

      {loading ? (
        <p className="text-[11px] text-muted-foreground">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">
          Nenhuma cobrança mensal ou data fixa nos próximos {days} dias.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => {
            const client = r.loans?.clients;
            const due = new Date(r.due_date + "T12:00:00");
            const daysLeft = Math.max(0, differenceInCalendarDays(due, today));
            const mark = marks[r.id];
            return (
              <div key={r.id} className="rounded-lg border border-border bg-card p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => navigate(`/loans/${r.loan_id}`)}
                      className="font-semibold text-sm truncate block text-left hover:underline"
                    >
                      {client?.name || "Cliente"}
                    </button>
                    <p className="text-[10px] text-muted-foreground">
                      {paymentLabel(r.loans?.payment_type || "")} • Parcela {r.number}
                      {client?.phone ? ` • ${client.phone}` : ""}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Vence em {format(due, "dd/MM/yyyy", { locale: ptBR })}
                      {" "}({daysLeft === 1 ? "1 dia" : `${daysLeft} dias`})
                    </p>
                    {mark && (
                      <p className="text-[10px] text-primary flex items-center gap-1 mt-0.5">
                        <BellRing className="h-3 w-3" />
                        Lembrete marcado em {format(new Date(mark.at), "dd/MM HH:mm")}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-sm tabular-nums">{formatCurrency(Number(r.amount))}</p>
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
                      {daysLeft === 0 ? "hoje" : `+${daysLeft}d`}
                    </Badge>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px] px-2 flex-1"
                    onClick={() => openWhats(r)}
                  >
                    <MessageCircle className="h-3.5 w-3.5 mr-1" /> WhatsApp
                  </Button>
                  <Button
                    size="sm"
                    variant={mark ? "secondary" : "default"}
                    className="h-7 text-[11px] px-2 flex-1"
                    onClick={() => markReminded(r)}
                  >
                    <Bell className="h-3.5 w-3.5 mr-1" />
                    {mark ? "Lembrado" : "Marcar lembrado"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px] px-2"
                    onClick={() => navigate(`/loans/${r.loan_id}`)}
                  >
                    <Eye className="h-3.5 w-3.5 mr-1" /> Detalhes
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
