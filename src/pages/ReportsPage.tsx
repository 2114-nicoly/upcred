import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/loan-utils";
import { BarChart3, TrendingUp, AlertTriangle, DollarSign, Calendar } from "lucide-react";
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";

type Installment = {
  id: string;
  amount: number;
  paid_amount: number;
  due_date: string;
  status: string;
  paid_at: string | null;
  is_penalty: boolean;
  loan_id: string;
};

export default function ReportsPage() {
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      const { data } = await supabase
        .from("installments")
        .select("id, amount, paid_amount, due_date, status, paid_at, is_penalty, loan_id")
        .order("due_date");
      setInstallments((data as Installment[]) || []);
      setLoading(false);
    };
    fetchData();
  }, []);

  const today = new Date();
  const todayStr = format(today, "yyyy-MM-dd");
  const weekStart = startOfWeek(today, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(today, { weekStartsOn: 1 });
  const monthStart = startOfMonth(today);
  const monthEnd = endOfMonth(today);

  const isInRange = (dateStr: string, start: Date, end: Date) => {
    const d = new Date(dateStr + "T12:00:00");
    return d >= start && d <= end;
  };

  // Regular (non-penalty) installments
  const regular = installments.filter((i) => !i.is_penalty);
  const penalties = installments.filter((i) => i.is_penalty);

  // Received today (paid_at is today)
  const paidToday = installments.filter((i) => i.paid_at && format(new Date(i.paid_at), "yyyy-MM-dd") === todayStr);
  const receivedToday = paidToday.filter((i) => !i.is_penalty).reduce((s, i) => s + Number(i.paid_amount), 0);
  const penaltyReceivedToday = paidToday.filter((i) => i.is_penalty).reduce((s, i) => s + Number(i.paid_amount), 0);

  // Received this week
  const paidThisWeek = installments.filter((i) => i.paid_at && isInRange(format(new Date(i.paid_at), "yyyy-MM-dd"), weekStart, weekEnd));
  const receivedWeek = paidThisWeek.filter((i) => !i.is_penalty).reduce((s, i) => s + Number(i.paid_amount), 0);
  const penaltyReceivedWeek = paidThisWeek.filter((i) => i.is_penalty).reduce((s, i) => s + Number(i.paid_amount), 0);

  // Received this month
  const paidThisMonth = installments.filter((i) => i.paid_at && isInRange(format(new Date(i.paid_at), "yyyy-MM-dd"), monthStart, monthEnd));
  const receivedMonth = paidThisMonth.filter((i) => !i.is_penalty).reduce((s, i) => s + Number(i.paid_amount), 0);
  const penaltyReceivedMonth = paidThisMonth.filter((i) => i.is_penalty).reduce((s, i) => s + Number(i.paid_amount), 0);

  // Expected today
  const expectedToday = regular.filter((i) => i.due_date === todayStr).reduce((s, i) => s + Number(i.amount), 0);

  // Expected this week
  const expectedWeek = regular.filter((i) => isInRange(i.due_date, weekStart, weekEnd)).reduce((s, i) => s + Number(i.amount), 0);

  // Expected this month
  const expectedMonth = regular.filter((i) => isInRange(i.due_date, monthStart, monthEnd)).reduce((s, i) => s + Number(i.amount), 0);

  // Totals
  const totalLoaned = regular.reduce((s, i) => s + Number(i.amount), 0);
  const totalPaid = regular.reduce((s, i) => s + Number(i.paid_amount), 0);
  const totalRemaining = totalLoaned - totalPaid;
  const totalPenalties = penalties.reduce((s, i) => s + Number(i.amount), 0);
  const totalPenaltiesPaid = penalties.reduce((s, i) => s + Number(i.paid_amount), 0);
  const overdueCount = regular.filter((i) => {
    const d = new Date(i.due_date + "T12:00:00");
    d.setHours(0,0,0,0);
    const t = new Date(); t.setHours(0,0,0,0);
    return i.status !== "paid" && d < t;
  }).length;

  if (loading) return <p className="p-4 text-center text-muted-foreground">Carregando...</p>;

  return (
    <div className="mx-auto max-w-lg p-4">
      <p className="mb-4 text-sm text-muted-foreground">
        {format(today, "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
      </p>

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-3 text-center">
            <DollarSign className="mx-auto mb-1 h-5 w-5 text-primary" />
            <p className="text-xs text-muted-foreground">Total a Receber</p>
            <p className="text-sm font-bold">{formatCurrency(totalRemaining)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <TrendingUp className="mx-auto mb-1 h-5 w-5 text-success" />
            <p className="text-xs text-muted-foreground">Total Recebido</p>
            <p className="text-sm font-bold text-success">{formatCurrency(totalPaid)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <AlertTriangle className="mx-auto mb-1 h-5 w-5 text-destructive" />
            <p className="text-xs text-muted-foreground">Multas Pendentes</p>
            <p className="text-sm font-bold text-destructive">{formatCurrency(totalPenalties - totalPenaltiesPaid)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <Calendar className="mx-auto mb-1 h-5 w-5 text-warning" />
            <p className="text-xs text-muted-foreground">Atrasadas</p>
            <p className="text-sm font-bold text-destructive">{overdueCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Today */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">📅 Hoje</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Esperado:</span><span>{formatCurrency(expectedToday)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Recebido:</span><span className="text-success font-semibold">{formatCurrency(receivedToday)}</span></div>
          {penaltyReceivedToday > 0 && (
            <div className="flex justify-between"><span className="text-muted-foreground">Multas recolhidas:</span><span className="text-destructive">{formatCurrency(penaltyReceivedToday)}</span></div>
          )}
        </CardContent>
      </Card>

      {/* Week */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">📆 Esta Semana</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Esperado:</span><span>{formatCurrency(expectedWeek)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Recebido:</span><span className="text-success font-semibold">{formatCurrency(receivedWeek)}</span></div>
          {penaltyReceivedWeek > 0 && (
            <div className="flex justify-between"><span className="text-muted-foreground">Multas recolhidas:</span><span className="text-destructive">{formatCurrency(penaltyReceivedWeek)}</span></div>
          )}
        </CardContent>
      </Card>

      {/* Month */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">🗓️ Este Mês</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Esperado:</span><span>{formatCurrency(expectedMonth)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Recebido:</span><span className="text-success font-semibold">{formatCurrency(receivedMonth)}</span></div>
          {penaltyReceivedMonth > 0 && (
            <div className="flex justify-between"><span className="text-muted-foreground">Multas recolhidas:</span><span className="text-destructive">{formatCurrency(penaltyReceivedMonth)}</span></div>
          )}
        </CardContent>
      </Card>

      {/* Totals */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">📊 Geral</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Total em parcelas:</span><span>{formatCurrency(totalLoaned)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Total recebido:</span><span className="text-success font-semibold">{formatCurrency(totalPaid)}</span></div>
          <div className="flex justify-between font-bold"><span>Saldo a receber:</span><span className="text-primary">{formatCurrency(totalRemaining)}</span></div>
          {totalPenalties > 0 && (
            <>
              <div className="border-t pt-2 flex justify-between"><span className="text-muted-foreground">Multas recolhidas:</span><span className="text-success">{formatCurrency(totalPenaltiesPaid)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Multas pendentes:</span><span className="text-destructive">{formatCurrency(totalPenalties - totalPenaltiesPaid)}</span></div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
