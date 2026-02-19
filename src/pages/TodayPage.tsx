import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCurrency, getStatusColor, getStatusLabel, getInstallmentDisplayStatus, calculateOverdueDays } from "@/lib/loan-utils";
import { CalendarDays, CheckCircle, XCircle, DollarSign, AlertTriangle, Plus, ClipboardList } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

type InstallmentWithLoan = {
  id: string;
  number: number;
  amount: number;
  due_date: string;
  status: string;
  loan_id: string;
  is_penalty: boolean;
  paid_amount: number;
  paid_at: string | null;
  loans: {
    id: string;
    client_id: string;
    amount: number;
    total_amount: number;
    installment_count: number;
    payment_type: string;
    clients: { id: string; name: string };
  };
};

type LoanProgress = {
  progress: number;
  total: number;
  remaining: number;
  penaltyTotal: number;
};

export default function TodayPage() {
  const navigate = useNavigate();
  const [installments, setInstallments] = useState<InstallmentWithLoan[]>([]);
  const [overdueCount, setOverdueCount] = useState(0);
  const [totalOverdue, setTotalOverdue] = useState(0);
  const [loanProgressMap, setLoanProgressMap] = useState<Record<string, LoanProgress>>({});
  const [loading, setLoading] = useState(true);
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const today = format(new Date(), "yyyy-MM-dd");

  const fetchInstallments = async () => {
    // Today's installments
    const { data } = await supabase
      .from("installments")
      .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
      .eq("due_date", today)
      .neq("status", "paid")
      .eq("is_penalty", false)
      .order("number");

    const todayInsts = (data as unknown as InstallmentWithLoan[]) || [];
    setInstallments(todayInsts);

    // Overdue count
    const { data: overdueData } = await supabase
      .from("installments")
      .select("amount, paid_amount")
      .lt("due_date", today)
      .neq("status", "paid")
      .eq("is_penalty", false);

    const overdueInsts = overdueData || [];
    setOverdueCount(overdueInsts.length);
    setTotalOverdue(overdueInsts.reduce((s: number, i: any) => s + (Number(i.amount) - Number(i.paid_amount)), 0));

    // Progress
    const uniqueLoanIds = [...new Set(todayInsts.map((d) => d.loan_id))];
    const progressMap: Record<string, LoanProgress> = {};
    for (const lid of uniqueLoanIds) {
      const { data: allInst } = await supabase
        .from("installments")
        .select("amount, paid_amount, is_penalty")
        .eq("loan_id", lid);
      if (!allInst) continue;
      const regular = allInst.filter((i: any) => !i.is_penalty);
      const penalties = allInst.filter((i: any) => i.is_penalty);
      const totalPaid = regular.reduce((s: number, i: any) => s + Number(i.paid_amount), 0);
      const instValue = regular.length > 0 ? Number(regular[0].amount) : 1;
      progressMap[lid] = {
        progress: totalPaid / instValue,
        total: regular.length,
        remaining: regular.reduce((s: number, i: any) => s + Number(i.amount), 0) - totalPaid,
        penaltyTotal: penalties.reduce((s: number, i: any) => s + Number(i.amount), 0),
      };
    }
    setLoanProgressMap(progressMap);
    setLoading(false);
  };

  useEffect(() => { fetchInstallments(); }, []);

  const handlePay = async (id: string) => {
    const inst = installments.find((i) => i.id === id);
    if (!inst) return;
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    const paidValue = payAmount ? parseFloat(payAmount) : instRemaining;
    if (isNaN(paidValue) || paidValue <= 0) { toast.error("Informe um valor válido"); return; }

    const newPaidAmount = Number(inst.paid_amount) + paidValue;
    const fullyPaid = newPaidAmount >= Number(inst.amount) - 0.01;

    await supabase.from("installments").update({
      paid_amount: Math.min(newPaidAmount, Number(inst.amount)),
      status: fullyPaid ? "paid" : inst.status,
      paid_at: fullyPaid ? new Date(payDate + "T12:00:00").toISOString() : inst.paid_at,
    }).eq("id", id);

    toast.success(`Pagamento de ${formatCurrency(paidValue)} registrado!`);
    setPayAmount(""); setPayDate(format(new Date(), "yyyy-MM-dd")); setPayDialogId(null);
    fetchInstallments();
  };

  const handleNotPaid = async (id: string) => {
    await supabase.from("installments").update({ status: "overdue" }).eq("id", id);
    toast.info("Parcela marcada como atrasada");
    fetchInstallments();
  };

  const totalToReceive = installments.reduce((sum, i) => sum + (Number(i.amount) - Number(i.paid_amount)), 0);

  const renderInstCard = (inst: InstallmentWithLoan) => {
    const lp = loanProgressMap[inst.loan_id];
    const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
    return (
      <Card key={inst.id} className="overflow-hidden">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="font-semibold">{inst.loans.clients.name}</p>
              <p className="text-sm text-muted-foreground">
                Parcela {inst.number} • {formatCurrency(Number(inst.amount))}
              </p>
              {lp && (
                <p className="text-xs text-primary font-medium">
                  {lp.progress % 1 === 0 ? lp.progress : lp.progress.toFixed(1)}/{lp.total} • Resta: {formatCurrency(Math.max(0, lp.remaining))}
                </p>
              )}
              {lp && lp.penaltyTotal > 0 && (
                <p className="text-xs text-destructive">Multa: {formatCurrency(lp.penaltyTotal)}</p>
              )}
            </div>
            <Badge className={getStatusColor(getInstallmentDisplayStatus(inst))}>
              {getStatusLabel(getInstallmentDisplayStatus(inst))}
            </Badge>
          </div>
          <div className="flex gap-2">
            <Dialog open={payDialogId === inst.id} onOpenChange={(o) => { setPayDialogId(o ? inst.id : null); if (!o) setPayAmount(""); }}>
              <DialogTrigger asChild>
                <Button size="sm" className="flex-1 bg-success hover:bg-success/90">
                  <Plus className="mr-1 h-4 w-4" /> Pagamento
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Registrar Pagamento</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {inst.loans.clients.name} — Parcela {inst.number} — {formatCurrency(Number(inst.amount))}
                  </p>
                  <div>
                    <Label>Valor recebido</Label>
                    <Input type="number" placeholder={`Padrão: ${instRemaining.toFixed(2)}`} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                  </div>
                  <div>
                    <Label>Data do pagamento</Label>
                    <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                  </div>
                  <Button onClick={() => handlePay(inst.id)} className="w-full bg-success hover:bg-success/90">
                    Confirmar Pagamento
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleNotPaid(inst.id)}>
              <XCircle className="mr-1 h-4 w-4" /> Não Pagou
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">
          <CalendarDays className="mr-2 inline h-6 w-6 text-primary" /> Hoje
        </h1>
        <p className="text-sm text-muted-foreground">
          {format(new Date(), "EEEE, dd 'de' MMMM", { locale: ptBR })}
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Card className="text-center">
          <CardContent className="p-3">
            <DollarSign className="mx-auto mb-1 h-5 w-5 text-primary" />
            <p className="text-xs text-muted-foreground">A Receber Hoje</p>
            <p className="text-sm font-bold">{formatCurrency(totalToReceive)}</p>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer text-center hover:border-destructive/50 transition-colors"
          onClick={() => navigate("/overdue")}
        >
          <CardContent className="p-3">
            <AlertTriangle className="mx-auto mb-1 h-5 w-5 text-warning" />
            <p className="text-xs text-muted-foreground">Atrasadas</p>
            <p className="text-sm font-bold text-destructive">{overdueCount}</p>
            {totalOverdue > 0 && <p className="text-xs text-destructive">{formatCurrency(totalOverdue)}</p>}
          </CardContent>
        </Card>
      </div>

      {/* Link to today summary */}
      <Button
        variant="outline"
        className="mb-4 w-full"
        onClick={() => navigate("/today-summary")}
      >
        <ClipboardList className="mr-2 h-4 w-4" /> Resumo do Dia (pagos / não pagos)
      </Button>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : installments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center p-8">
            <CheckCircle className="mb-2 h-12 w-12 text-success" />
            <p className="text-lg font-semibold">Nenhuma cobrança para hoje!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {installments.map((inst) => renderInstCard(inst))}
        </div>
      )}
    </div>
  );
}
