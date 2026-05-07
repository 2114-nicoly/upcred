import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCurrency, getStatusColor, getStatusLabel, getInstallmentDisplayStatus } from "@/lib/loan-utils";
import { registerPayment, registerPenaltyPayment } from "@/lib/payment-utils";
import { ArrowLeft, Plus, XCircle, Undo2, Pencil, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { useConfirm } from "@/hooks/useConfirm";

type Installment = {
  id: string;
  number: number;
  amount: number;
  due_date: string;
  status: string;
  paid_at: string | null;
  is_penalty: boolean;
  penalty_amount: number;
  paid_amount: number;
  loan_id: string;
};

type Loan = {
  id: string;
  client_id: string;
  total_amount: number;
  clients: { name: string };
};

export default function UnpaidInstallmentsPage() {
  const { loanId } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [loan, setLoan] = useState<Loan | null>(null);
  const [loading, setLoading] = useState(true);
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payPenaltyAmount, setPayPenaltyAmount] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [editInstId, setEditInstId] = useState<string | null>(null);
  const [editInstAmount, setEditInstAmount] = useState("");
  const [editInstDueDate, setEditInstDueDate] = useState("");

  const fetchData = async () => {
    const { data: l } = await supabase.from("loans").select("id, client_id, total_amount, clients(name)").eq("id", loanId!).single();
    setLoan(l as unknown as Loan);

    const { data: insts } = await supabase
      .from("installments")
      .select("*")
      .eq("loan_id", loanId!)
      .eq("is_penalty", false)
      .neq("status", "paid")
      .order("number");

    // Filter: unpaid or partially paid (not fully paid)
    const filtered = (insts || []).filter((i: any) => {
      const ds = getInstallmentDisplayStatus(i);
      return ds === "overdue" || ds === "pending" || ds === "due_today" || ds === "partial";
    });
    setInstallments(filtered);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [loanId]);

  const updateLoanStatus = async () => {
    const { data: inst } = await supabase.from("installments").select("status, due_date").eq("loan_id", loanId!);
    if (!inst) return;
    const todayStr = format(new Date(), "yyyy-MM-dd");
    const allPaid = inst.every((i: any) => i.status === "paid");
    const hasOverdue = inst.some((i: any) => i.status === "overdue" || (i.status !== "paid" && i.due_date < todayStr));
    let newStatus = "open";
    if (allPaid) newStatus = "paid";
    else if (hasOverdue) newStatus = "overdue";
    await supabase.from("loans").update({ status: newStatus }).eq("id", loanId!);
  };

  const handlePay = async (id: string) => {
    const inst = installments.find((i) => i.id === id);
    if (!inst) return;
    const parcValue = payAmount ? parseFloat(payAmount) : null;
    const multaValue = payPenaltyAmount ? parseFloat(payPenaltyAmount) : 0;
    if (payAmount && (isNaN(parcValue!) || parcValue! <= 0)) { toast.error("Valor inválido"); return; }

    try {
      if (multaValue > 0 && loan) {
        await registerPenaltyPayment({
          loanId: loanId!,
          amount: multaValue,
          clientId: loan.client_id,
          clientName: loan.clients.name,
          cashDate: payDate,
          origin: "parcelas_pendentes",
        });
        toast.success(`Multa: ${formatCurrency(multaValue)} registrado!`);
      }

      if (parcValue !== null || !payPenaltyAmount) {
      const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
      const paidValue = parcValue ?? instRemaining;
        if (paidValue > 0 && loan) {
          const { applied } = await registerPayment({
            loanId: loanId!,
            amount: paidValue,
            clientId: loan.client_id,
            clientName: loan.clients.name,
            cashDate: payDate,
            origin: "parcelas_pendentes",
            installmentId: inst.id,
            startInstNumber: inst.number,
          });
          toast.success(`Parcela: ${formatCurrency(applied)} registrado!`);
        }
      }
    } catch (err: any) {
      console.error("Unpaid handlePay error:", err);
      toast.error(err?.message || "Erro ao registrar pagamento");
    }

    setPayAmount(""); setPayPenaltyAmount(""); setPayDate(format(new Date(), "yyyy-MM-dd")); setPayDialogId(null);
    fetchData();
  };

  const handleNotPaid = async (id: string) => {
    await supabase.from("installments").update({ status: "overdue" }).eq("id", id);
    await updateLoanStatus();
    toast.info("Parcela marcada como atrasada");
    fetchData();
  };

  const handleUndoOverdue = async (id: string) => {
    await supabase.from("installments").update({ status: "pending" }).eq("id", id);
    await updateLoanStatus();
    toast.success("Status restaurado para pendente!");
    fetchData();
  };

  const handleEditInstallment = async () => {
    if (!editInstId) return;
    const newAmount = parseFloat(editInstAmount);
    if (isNaN(newAmount) || newAmount <= 0) { toast.error("Valor inválido"); return; }
    await supabase.from("installments").update({ amount: newAmount, due_date: editInstDueDate }).eq("id", editInstId);
    toast.success("Parcela atualizada!");
    setEditInstId(null);
    fetchData();
  };

  const handleDeleteInstallment = async (id: string) => {
    const inst = installments.find((i) => i.id === id);
    const ok = await confirm({
      title: "Excluir parcela?",
      affected: inst ? [
        { label: "Parcela", value: `#${inst.number}` },
        { label: "Valor", value: formatCurrency(Number(inst.amount)) },
      ] : undefined,
      confirmText: "Excluir", destructive: true,
    });
    if (!ok) return;
    await supabase.from("penalties").delete().eq("installment_id", id);
    await supabase.from("installments").delete().eq("id", id);
    toast.success("Parcela excluída!");
    fetchData();
  };

  return (
    <div className="mx-auto max-w-lg p-4">

      {loan && (
        <p className="mb-4 text-sm text-muted-foreground">
          Cliente: <span className="font-medium text-foreground">{loan.clients.name}</span>
        </p>
      )}

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : installments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center p-8">
            <p className="text-lg font-semibold">Nenhuma parcela pendente! 🎉</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {installments.map((inst) => {
            const displayStatus = getInstallmentDisplayStatus(inst);
            const instRemaining = Number(inst.amount) - Number(inst.paid_amount);
            return (
              <Card key={inst.id}>
                <CardContent className="p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex-1">
                      <p className="font-semibold">Parcela {inst.number}</p>
                      <p className="text-sm text-muted-foreground">
                        Venc: {format(new Date(inst.due_date + "T12:00:00"), "dd/MM/yyyy")} • {formatCurrency(Number(inst.amount))}
                      </p>
                      {Number(inst.paid_amount) > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Pago: {formatCurrency(Number(inst.paid_amount))} • Resta: {formatCurrency(instRemaining)}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Badge className={getStatusColor(displayStatus)}>{getStatusLabel(displayStatus)}</Badge>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => {
                        setEditInstId(inst.id);
                        setEditInstAmount(String(inst.amount));
                        setEditInstDueDate(inst.due_date);
                      }}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => handleDeleteInstallment(inst.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Dialog open={payDialogId === inst.id} onOpenChange={(o) => { setPayDialogId(o ? inst.id : null); if (!o) { setPayAmount(""); setPayPenaltyAmount(""); } }}>
                      <DialogTrigger asChild>
                        <Button size="sm" className="flex-1 bg-success hover:bg-success/90">
                          <Plus className="mr-1 h-3 w-3" /> Pagamento
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader><DialogTitle>Registrar Pagamento</DialogTitle></DialogHeader>
                        <div className="space-y-3">
                          <p className="text-sm text-muted-foreground">Parcela {inst.number} — {formatCurrency(Number(inst.amount))}</p>
                          {Number(inst.paid_amount) > 0 && <p className="text-sm">Já pago: {formatCurrency(Number(inst.paid_amount))} — Resta: {formatCurrency(instRemaining)}</p>}
                          <div>
                            <Label>Valor da parcela recebido</Label>
                            <Input type="number" placeholder={`Padrão: ${instRemaining.toFixed(2)}`} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                          </div>
                          <div className="rounded-lg border border-warning/50 p-3 space-y-2">
                            <Label>Valor destinado à multa (opcional)</Label>
                            <Input type="number" placeholder="0.00" value={payPenaltyAmount} onChange={(e) => setPayPenaltyAmount(e.target.value)} />
                          </div>
                          <div>
                            <Label>Data do pagamento</Label>
                            <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                          </div>
                          <Button onClick={() => handlePay(inst.id)} className="w-full bg-success hover:bg-success/90">Confirmar Pagamento</Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                    <Button size="sm" variant="destructive" className="flex-1" onClick={() => handleNotPaid(inst.id)}>
                      <XCircle className="mr-1 h-3 w-3" /> Não Pagou
                    </Button>
                  </div>
                  {inst.status === "overdue" && (
                    <Button size="sm" variant="outline" className="w-full mt-1" onClick={() => handleUndoOverdue(inst.id)}>
                      <Undo2 className="mr-1 h-3 w-3" /> Desfazer "Não Pagou"
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Edit Installment Dialog */}
      <Dialog open={!!editInstId} onOpenChange={(o) => { if (!o) setEditInstId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Parcela</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Valor da parcela</Label>
              <Input type="number" value={editInstAmount} onChange={(e) => setEditInstAmount(e.target.value)} />
            </div>
            <div>
              <Label>Data de vencimento</Label>
              <Input type="date" value={editInstDueDate} onChange={(e) => setEditInstDueDate(e.target.value)} />
            </div>
            <Button onClick={handleEditInstallment} className="w-full">Salvar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
