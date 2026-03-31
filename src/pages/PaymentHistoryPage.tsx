import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency, getStatusColor, getStatusLabel } from "@/lib/loan-utils";
import { CalendarCheck, ChevronDown, ChevronUp, Pencil, Trash2 } from "lucide-react";
import { ListSkeleton, EmptyState } from "@/components/LoadingSkeleton";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

type PaidInstallment = {
  id: string;
  number: number;
  amount: number;
  due_date: string;
  paid_at: string;
  paid_amount: number;
  is_penalty: boolean;
  loan_id: string;
  loans: { id: string; amount: number; clients: { name: string } };
};

function getDayLabel(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  if (isToday(date)) return "Hoje";
  if (isYesterday(date)) return "Ontem";
  return format(date, "EEEE, dd/MM/yyyy", { locale: ptBR });
}

export default function PaymentHistoryPage() {
  const [installmentsByDay, setInstallmentsByDay] = useState<Record<string, PaidInstallment[]>>({});
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editInst, setEditInst] = useState<PaidInstallment | null>(null);
  const [editPaidAmount, setEditPaidAmount] = useState("");
  const [editPaidDate, setEditPaidDate] = useState("");

  const fetchData = async () => {
    const { data } = await supabase
      .from("installments")
      .select("*, loans(id, amount, clients(name))")
      .eq("status", "paid")
      .not("paid_at", "is", null)
      .order("paid_at", { ascending: false });

    const grouped: Record<string, PaidInstallment[]> = {};
    ((data as unknown as PaidInstallment[]) || []).forEach((inst) => {
      const day = format(new Date(inst.paid_at), "yyyy-MM-dd");
      if (!grouped[day]) grouped[day] = [];
      grouped[day].push(inst);
    });
    setInstallmentsByDay(grouped);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleUndoPayment = async (inst: PaidInstallment) => {
    if (!confirm("Desfazer este pagamento? A parcela voltará como pendente.")) return;
    await supabase.from("installments").update({
      status: "pending",
      paid_at: null,
      paid_amount: 0,
    }).eq("id", inst.id);

    const { data: allInst } = await supabase.from("installments").select("status, due_date").eq("loan_id", inst.loan_id);
    if (allInst) {
      const todayStr = format(new Date(), "yyyy-MM-dd");
      const allPaid = allInst.every((i: any) => i.status === "paid");
      const hasOverdue = allInst.some((i: any) => i.status !== "paid" && i.due_date < todayStr);
      let newStatus = "open";
      if (allPaid) newStatus = "paid";
      else if (hasOverdue) newStatus = "overdue";
      await supabase.from("loans").update({ status: newStatus }).eq("id", inst.loan_id);
    }

    toast.success("Pagamento desfeito!");
    fetchData();
  };

  const handleEditPayment = async () => {
    if (!editInst) return;
    const newAmount = parseFloat(editPaidAmount);
    if (isNaN(newAmount) || newAmount <= 0) { toast.error("Valor inválido"); return; }

    const fullyPaid = newAmount >= Number(editInst.amount) - 0.01;
    await supabase.from("installments").update({
      paid_amount: Math.min(newAmount, Number(editInst.amount)),
      status: fullyPaid ? "paid" : "pending",
      paid_at: fullyPaid ? new Date(editPaidDate + "T12:00:00").toISOString() : null,
    }).eq("id", editInst.id);

    const { data: allInst } = await supabase.from("installments").select("status, due_date").eq("loan_id", editInst.loan_id);
    if (allInst) {
      const todayStr = format(new Date(), "yyyy-MM-dd");
      const allPaid = allInst.every((i: any) => i.status === "paid");
      const hasOverdue = allInst.some((i: any) => i.status !== "paid" && i.due_date < todayStr);
      let newStatus = "open";
      if (allPaid) newStatus = "paid";
      else if (hasOverdue) newStatus = "overdue";
      await supabase.from("loans").update({ status: newStatus }).eq("id", editInst.loan_id);
    }

    toast.success("Pagamento atualizado!");
    setEditInst(null);
    fetchData();
  };

  const days = Object.keys(installmentsByDay).sort((a, b) => b.localeCompare(a));

  return (
    <div className="mx-auto max-w-lg p-4">

      {loading ? (
        <ListSkeleton count={4} />
      ) : days.length === 0 ? (
        <EmptyState icon={CalendarCheck} message="Nenhum pagamento registrado" />
      ) : (
        <div className="space-y-2">
          {days.map((day) => {
            const insts = installmentsByDay[day];
            const total = insts.reduce((s, i) => s + Number(i.paid_amount || i.amount), 0);
            const isExpanded = expandedDay === day;
            return (
              <Card key={day}>
                <button className="flex w-full items-center justify-between p-4 text-left" onClick={() => setExpandedDay(isExpanded ? null : day)}>
                  <div>
                    <p className="font-semibold capitalize">{getDayLabel(day)}</p>
                    <p className="text-sm text-muted-foreground">{insts.length} pagamento(s) • {formatCurrency(total)}</p>
                  </div>
                  {isExpanded ? <ChevronUp className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
                </button>
                {isExpanded && (
                  <CardContent className="space-y-2 border-t pt-3">
                    {insts.map((inst) => (
                      <div key={inst.id} className="flex items-center justify-between rounded-lg bg-accent p-3">
                        <div>
                          <p className="font-medium">{inst.loans.clients.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {inst.is_penalty ? "Multa" : `Parcela ${inst.number}`} • {formatCurrency(Number(inst.paid_amount || inst.amount))}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Badge className={getStatusColor("paid")}>{getStatusLabel("paid")}</Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => {
                              setEditInst(inst);
                              setEditPaidAmount(String(inst.paid_amount || inst.amount));
                              setEditPaidDate(format(new Date(inst.paid_at), "yyyy-MM-dd"));
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-destructive"
                            onClick={() => handleUndoPayment(inst)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!editInst} onOpenChange={(o) => { if (!o) setEditInst(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Pagamento</DialogTitle></DialogHeader>
          {editInst && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {editInst.loans.clients.name} — {editInst.is_penalty ? "Multa" : `Parcela ${editInst.number}`}
              </p>
              <p className="text-sm text-muted-foreground">Valor da parcela: {formatCurrency(Number(editInst.amount))}</p>
              <div>
                <Label>Valor pago</Label>
                <Input type="number" value={editPaidAmount} onChange={(e) => setEditPaidAmount(e.target.value)} />
              </div>
              <div>
                <Label>Data do pagamento</Label>
                <Input type="date" value={editPaidDate} onChange={(e) => setEditPaidDate(e.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">⚠️ Se o valor for menor que a parcela, o status voltará para pendente.</p>
              <Button onClick={handleEditPayment} className="w-full">Salvar</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
