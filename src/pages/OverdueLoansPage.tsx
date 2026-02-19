import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCurrency, getStatusColor, getStatusLabel, calculateOverdueDays } from "@/lib/loan-utils";
import { ArrowLeft, ChevronDown, Plus, AlertTriangle, XCircle } from "lucide-react";
import { format } from "date-fns";
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
  penalty_amount: number;
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

type LoanGroup = {
  loanId: string;
  clientName: string;
  paymentType: string;
  totalAmount: number;
  installments: InstallmentWithLoan[];
  totalOverdue: number;
  overdueDays: number;
};

export default function OverdueLoansPage() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<LoanGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedLoan, setExpandedLoan] = useState<string | null>(null);
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [payIsPenalty, setPayIsPenalty] = useState(false);
  const [penaltyDialogId, setPenaltyDialogId] = useState<string | null>(null);
  const [penaltyAmount, setPenaltyAmount] = useState("");
  const [penaltyObservation, setPenaltyObservation] = useState("");

  const today = format(new Date(), "yyyy-MM-dd");

  const fetchData = async () => {
    const { data } = await supabase
      .from("installments")
      .select("*, loans(id, client_id, amount, total_amount, installment_count, payment_type, clients(id, name))")
      .lt("due_date", today)
      .neq("status", "paid")
      .eq("is_penalty", false)
      .order("due_date");

    const insts = (data as unknown as InstallmentWithLoan[]) || [];
    
    const grouped: Record<string, LoanGroup> = {};
    for (const inst of insts) {
      if (!grouped[inst.loan_id]) {
        // Find the oldest overdue date for this loan
        const oldestDueDate = inst.due_date;
        grouped[inst.loan_id] = {
          loanId: inst.loan_id,
          clientName: inst.loans.clients.name,
          paymentType: inst.loans.payment_type,
          totalAmount: Number(inst.loans.total_amount),
          installments: [],
          totalOverdue: 0,
          overdueDays: calculateOverdueDays(oldestDueDate, inst.loans.payment_type),
        };
      }
      grouped[inst.loan_id].installments.push(inst);
      grouped[inst.loan_id].totalOverdue += Number(inst.amount) - Number(inst.paid_amount);
    }

    setGroups(Object.values(grouped).sort((a, b) => b.overdueDays - a.overdueDays));
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handlePay = async (id: string) => {
    const allInsts = groups.flatMap(g => g.installments);
    const inst = allInsts.find((i) => i.id === id);
    if (!inst) return;

    if (payIsPenalty) {
      // Find penalty installment for this loan
      const { data: penaltyInsts } = await supabase
        .from("installments")
        .select("*")
        .eq("loan_id", inst.loan_id)
        .eq("is_penalty", true);
      const penaltyInst = penaltyInsts?.[0];
      if (!penaltyInst) { toast.error("Nenhuma multa registrada"); return; }
      const instRemaining = Number(penaltyInst.amount) - Number(penaltyInst.paid_amount);
      const val = payAmount ? parseFloat(payAmount) : instRemaining;
      if (isNaN(val) || val <= 0) { toast.error("Valor inválido"); return; }
      const newPaid = Number(penaltyInst.paid_amount) + val;
      const fullyPaid = newPaid >= Number(penaltyInst.amount) - 0.01;
      await supabase.from("installments").update({
        paid_amount: Math.min(newPaid, Number(penaltyInst.amount)),
        status: fullyPaid ? "paid" : penaltyInst.status,
        paid_at: fullyPaid ? new Date(payDate + "T12:00:00").toISOString() : penaltyInst.paid_at,
      }).eq("id", penaltyInst.id);
      toast.success(`Pagamento de multa de ${formatCurrency(val)} registrado!`);
    } else {
      const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
      const paidValue = payAmount ? parseFloat(payAmount) : instRemaining;
      if (isNaN(paidValue) || paidValue <= 0) { toast.error("Valor inválido"); return; }
      const newPaidAmount = Number(inst.paid_amount) + paidValue;
      const fullyPaid = newPaidAmount >= Number(inst.amount) - 0.01;
      await supabase.from("installments").update({
        paid_amount: Math.min(newPaidAmount, Number(inst.amount)),
        status: fullyPaid ? "paid" : inst.status,
        paid_at: fullyPaid ? new Date(payDate + "T12:00:00").toISOString() : inst.paid_at,
      }).eq("id", id);
      toast.success(`Pagamento de ${formatCurrency(paidValue)} registrado!`);
    }

    setPayAmount(""); setPayDate(format(new Date(), "yyyy-MM-dd")); setPayDialogId(null); setPayIsPenalty(false);
    fetchData();
  };

  const handleAddPenalty = async (inst: InstallmentWithLoan) => {
    const amount = parseFloat(penaltyAmount);
    if (!amount || amount <= 0) { toast.error("Valor inválido"); return; }

    await supabase.from("penalties").insert({
      loan_id: inst.loan_id,
      installment_id: inst.id,
      amount,
      observation: penaltyObservation || null,
    });

    await supabase.from("installments").update({
      penalty_amount: Number(inst.penalty_amount) + amount,
    }).eq("id", inst.id);

    // Update or create penalty installment
    const { data: penaltyInsts } = await supabase
      .from("installments")
      .select("*")
      .eq("loan_id", inst.loan_id)
      .eq("is_penalty", true);

    if (penaltyInsts && penaltyInsts.length > 0) {
      await supabase.from("installments").update({
        amount: Number(penaltyInsts[0].amount) + amount,
      }).eq("id", penaltyInsts[0].id);
    } else {
      const { data: maxInst } = await supabase
        .from("installments")
        .select("number")
        .eq("loan_id", inst.loan_id)
        .order("number", { ascending: false })
        .limit(1);
      const maxNum = maxInst?.[0]?.number ?? 0;
      await supabase.from("installments").insert({
        loan_id: inst.loan_id,
        number: maxNum + 1,
        amount,
        due_date: format(new Date(), "yyyy-MM-dd"),
        is_penalty: true,
        status: "pending",
      });
    }

    toast.success("Multa adicionada!");
    setPenaltyAmount(""); setPenaltyObservation(""); setPenaltyDialogId(null);
    fetchData();
  };

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-4 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
        </Button>
        <h1 className="text-xl font-bold text-destructive">
          <AlertTriangle className="mr-1 inline h-5 w-5" /> Parcelas Atrasadas
        </h1>
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center p-8">
            <p className="text-lg font-semibold">Nenhuma parcela atrasada! 🎉</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <Collapsible
              key={group.loanId}
              open={expandedLoan === group.loanId}
              onOpenChange={(o) => setExpandedLoan(o ? group.loanId : null)}
            >
              <CollapsibleTrigger asChild>
                <Card className="cursor-pointer border-destructive/30 hover:border-destructive/60 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold">{group.clientName}</p>
                        <p className="text-sm text-muted-foreground">
                          {group.installments.length} parcela{group.installments.length > 1 ? "s" : ""} atrasada{group.installments.length > 1 ? "s" : ""}
                        </p>
                        <p className="text-sm font-medium text-destructive">
                          {group.overdueDays} dia{group.overdueDays !== 1 ? "s" : ""} de atraso
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Total: {formatCurrency(group.totalOverdue)}
                        </p>
                      </div>
                      <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${expandedLoan === group.loanId ? "rotate-180" : ""}`} />
                    </div>
                  </CardContent>
                </Card>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2 pl-2">
                {group.installments.map((inst) => {
                  const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
                  const days = calculateOverdueDays(inst.due_date, group.paymentType);
                  return (
                    <Card key={inst.id}>
                      <CardContent className="p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <div>
                            <p className="font-semibold">Parcela {inst.number}</p>
                            <p className="text-sm text-muted-foreground">
                              Venc: {format(new Date(inst.due_date + "T12:00:00"), "dd/MM/yyyy")} • {formatCurrency(Number(inst.amount))}
                            </p>
                            <p className="text-xs text-destructive font-medium">
                              {days} dia{days !== 1 ? "s" : ""} de atraso
                            </p>
                            {Number(inst.paid_amount) > 0 && (
                              <p className="text-xs text-muted-foreground">Pago: {formatCurrency(Number(inst.paid_amount))} / Resta: {formatCurrency(instRemaining)}</p>
                            )}
                          </div>
                          <Badge className={getStatusColor("overdue")}>{getStatusLabel("overdue")}</Badge>
                        </div>
                        <div className="flex gap-2">
                          <Dialog open={payDialogId === inst.id} onOpenChange={(o) => { setPayDialogId(o ? inst.id : null); if (!o) { setPayAmount(""); setPayIsPenalty(false); } }}>
                            <DialogTrigger asChild>
                              <Button size="sm" className="flex-1 bg-success hover:bg-success/90">
                                <Plus className="mr-1 h-3 w-3" /> Pagamento
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader><DialogTitle>Registrar Pagamento</DialogTitle></DialogHeader>
                              <div className="space-y-3">
                                <p className="text-sm text-muted-foreground">
                                  {group.clientName} — Parcela {inst.number} — {formatCurrency(Number(inst.amount))}
                                </p>
                                <div>
                                  <Label>Valor recebido</Label>
                                  <Input type="number" placeholder={`Padrão: ${instRemaining.toFixed(2)}`} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                                </div>
                                <div>
                                  <Label>Data do pagamento</Label>
                                  <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                                </div>
                                <div className="flex items-center justify-between rounded-lg border p-3">
                                  <Label className="text-sm">Valor de multa?</Label>
                                  <Switch checked={payIsPenalty} onCheckedChange={setPayIsPenalty} />
                                </div>
                                <Button onClick={() => handlePay(inst.id)} className="w-full bg-success hover:bg-success/90">Confirmar Pagamento</Button>
                              </div>
                            </DialogContent>
                          </Dialog>
                          <Dialog open={penaltyDialogId === inst.id} onOpenChange={(o) => { setPenaltyDialogId(o ? inst.id : null); if (!o) { setPenaltyAmount(""); setPenaltyObservation(""); } }}>
                            <DialogTrigger asChild>
                              <Button size="sm" variant="outline" className="px-2">
                                <AlertTriangle className="h-3 w-3" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader><DialogTitle>Adicionar Multa</DialogTitle></DialogHeader>
                              <div className="space-y-3">
                                <p className="text-sm text-muted-foreground">{group.clientName} — Parcela {inst.number}</p>
                                <div>
                                  <Label>Valor da multa</Label>
                                  <Input type="number" placeholder="Valor" value={penaltyAmount} onChange={(e) => setPenaltyAmount(e.target.value)} />
                                </div>
                                <div>
                                  <Label>Observação (opcional)</Label>
                                  <Textarea placeholder="Motivo da multa..." value={penaltyObservation} onChange={(e) => setPenaltyObservation(e.target.value)} />
                                </div>
                                <Button onClick={() => handleAddPenalty(inst)} className="w-full">Adicionar Multa</Button>
                              </div>
                            </DialogContent>
                          </Dialog>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                <Button
                  variant="link"
                  size="sm"
                  className="w-full text-primary"
                  onClick={() => navigate(`/loans/${group.loanId}`)}
                >
                  Ver empréstimo completo →
                </Button>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      )}
    </div>
  );
}
