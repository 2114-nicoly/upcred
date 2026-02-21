import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/loan-utils";
import {
  getCashBalance,
  updateCashBalance,
  createCashMovement,
  deleteCashMovement,
  getMovementTypeLabel,
  getMovementTypeColor,
  CashBalance,
  CashMovement,
} from "@/lib/cash-utils";
import { Wallet, TrendingUp, TrendingDown, AlertTriangle, Plus, Minus, Settings, History, Pencil, Trash2, Undo2 } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

export default function CaixaPage() {
  const navigate = useNavigate();
  const [balance, setBalance] = useState<CashBalance | null>(null);
  const [movements, setMovements] = useState<(CashMovement & { clients?: { name: string } | null })[]>([]);
  const [penaltyPending, setPenaltyPending] = useState(0);
  const [loading, setLoading] = useState(true);

  // Manual movement dialog
  const [manualType, setManualType] = useState<"entrada_manual" | "saida_manual" | "ajuste_manual" | null>(null);
  const [manualAmount, setManualAmount] = useState("");
  const [manualObs, setManualObs] = useState("");

  // Edit movement
  const [editId, setEditId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editObs, setEditObs] = useState("");

  const fetchData = async () => {
    const bal = await getCashBalance();
    setBalance(bal);

    const { data: movs } = await supabase
      .from("cash_movements")
      .select("*, clients(name)")
      .order("created_at", { ascending: false })
      .limit(10);
    setMovements((movs as any) || []);

    // Calculate penalty pending from installments (same as report)
    const { data: penaltyInstallments } = await supabase
      .from("installments")
      .select("amount, paid_amount")
      .eq("is_penalty", true);
    if (penaltyInstallments) {
      const total = penaltyInstallments.reduce((s, i) => s + Number(i.amount), 0);
      const paid = penaltyInstallments.reduce((s, i) => s + Number(i.paid_amount), 0);
      setPenaltyPending(total - paid);
    }

    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleManualMovement = async () => {
    if (!manualType) return;
    const amount = parseFloat(manualAmount);
    if (!amount || amount <= 0) { toast.error("Informe um valor válido"); return; }

    const cashChange = manualType === "saida_manual" ? -amount : amount;
    await updateCashBalance({ available_cash: cashChange });
    await createCashMovement({
      type: manualType,
      amount: manualType === "saida_manual" ? -amount : amount,
      observation: manualObs || null,
    });

    toast.success(getMovementTypeLabel(manualType) + " registrada!");
    setManualType(null);
    setManualAmount("");
    setManualObs("");
    fetchData();
  };

  const handleDeleteMovement = async (mov: CashMovement & { clients?: { name: string } | null }) => {
    if (!confirm("Excluir esta movimentação? O saldo será revertido.")) return;

    // Reverse the cash effect
    const reverseMap: Record<string, Partial<Record<string, number>>> = {
      emprestimo: { available_cash: Number(mov.amount), money_lent: -Number(mov.amount) },
      recebimento_normal: { available_cash: -Number(mov.amount) },
      recebimento_multa: { available_cash: -Number(mov.amount), penalty_receivable: Number(mov.amount) },
      entrada_manual: { available_cash: -Number(mov.amount) },
      saida_manual: { available_cash: -Number(mov.amount) }, // amount is already negative
      ajuste_manual: { available_cash: -Number(mov.amount) },
    };

    const reverse = reverseMap[mov.type] || {};
    await updateCashBalance(reverse as any);
    await deleteCashMovement(mov.id);
    toast.success("Movimentação excluída e saldo revertido!");
    fetchData();
  };

  const handleEditMovement = async () => {
    if (!editId) return;
    const newAmount = parseFloat(editAmount);
    if (isNaN(newAmount)) { toast.error("Valor inválido"); return; }

    const mov = movements.find(m => m.id === editId);
    if (!mov) return;

    const diff = newAmount - Number(mov.amount);

    // Adjust cash balance by the difference
    if (mov.type === "emprestimo") {
      await updateCashBalance({ available_cash: -diff, money_lent: diff });
    } else if (mov.type === "recebimento_multa") {
      await updateCashBalance({ available_cash: diff, penalty_receivable: -diff });
    } else {
      await updateCashBalance({ available_cash: diff });
    }

    await supabase.from("cash_movements").update({ amount: newAmount, observation: editObs || mov.observation }).eq("id", editId);
    toast.success("Movimentação atualizada!");
    setEditId(null);
    fetchData();
  };

  if (loading) return <p className="p-4 text-center text-muted-foreground">Carregando...</p>;

  return (
    <div className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-bold">
        <Wallet className="mr-2 inline h-6 w-6 text-primary" /> Caixa
      </h1>

      {/* Balance cards */}
      {balance && (
        <div className="mb-6 grid grid-cols-2 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <Wallet className="mx-auto mb-1 h-5 w-5 text-primary" />
              <p className="text-xs text-muted-foreground">Caixa Disponível</p>
              <p className={`text-sm font-bold ${Number(balance.available_cash) < 0 ? "text-destructive" : "text-primary"}`}>
                {formatCurrency(Number(balance.available_cash))}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <TrendingUp className="mx-auto mb-1 h-5 w-5 text-warning" />
              <p className="text-xs text-muted-foreground">Dinheiro Emprestado</p>
              <p className="text-sm font-bold">{formatCurrency(Number(balance.money_lent))}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <TrendingDown className="mx-auto mb-1 h-5 w-5 text-success" />
              <p className="text-xs text-muted-foreground">Juros a Receber</p>
              <p className="text-sm font-bold text-success">{formatCurrency(Number(balance.interest_receivable))}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <AlertTriangle className="mx-auto mb-1 h-5 w-5 text-destructive" />
              <p className="text-xs text-muted-foreground">Multas Pendentes</p>
              <p className="text-sm font-bold text-destructive">{formatCurrency(penaltyPending)}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Action buttons */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        <Button variant="outline" className="text-success border-success/50" onClick={() => setManualType("entrada_manual")}>
          <Plus className="mr-1 h-4 w-4" /> Entrada
        </Button>
        <Button variant="outline" className="text-destructive border-destructive/50" onClick={() => setManualType("saida_manual")}>
          <Minus className="mr-1 h-4 w-4" /> Saída
        </Button>
        <Button variant="outline" onClick={() => setManualType("ajuste_manual")}>
          <Settings className="mr-1 h-4 w-4" /> Ajuste
        </Button>
      </div>

      <Button variant="outline" className="mb-4 w-full" onClick={() => navigate("/cash-history")}>
        <History className="mr-2 h-4 w-4" /> Histórico Completo
      </Button>

      {/* Manual movement dialog */}
      <Dialog open={manualType !== null} onOpenChange={(o) => { if (!o) setManualType(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {manualType === "entrada_manual" && "Entrada Manual"}
              {manualType === "saida_manual" && "Saída Manual"}
              {manualType === "ajuste_manual" && "Ajuste Manual"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Valor (R$)</Label>
              <Input type="number" value={manualAmount} onChange={(e) => setManualAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <Label>Observação (opcional)</Label>
              <Textarea value={manualObs} onChange={(e) => setManualObs(e.target.value)} placeholder="Descrição..." />
            </div>
            <Button onClick={handleManualMovement} className="w-full">Confirmar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit movement dialog */}
      <Dialog open={editId !== null} onOpenChange={(o) => { if (!o) setEditId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Movimentação</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Valor (R$)</Label>
              <Input type="number" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} />
            </div>
            <div>
              <Label>Observação</Label>
              <Textarea value={editObs} onChange={(e) => setEditObs(e.target.value)} />
            </div>
            <Button onClick={handleEditMovement} className="w-full">Salvar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Recent movements */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Últimas Movimentações</CardTitle>
        </CardHeader>
        <CardContent>
          {movements.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Nenhuma movimentação registrada</p>
          ) : (
            <div className="space-y-3">
              {movements.map((mov) => (
                <div key={mov.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                  <div className="flex-1">
                    <p className={`text-sm font-medium ${getMovementTypeColor(mov.type)}`}>
                      {getMovementTypeLabel(mov.type)}
                    </p>
                    {mov.clients?.name && <p className="text-xs text-muted-foreground">{mov.clients.name}</p>}
                    {mov.observation && <p className="text-xs text-muted-foreground">{mov.observation}</p>}
                    <p className="text-xs text-muted-foreground">{format(new Date(mov.created_at), "dd/MM/yyyy HH:mm")}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={`text-sm font-bold ${Number(mov.amount) >= 0 ? "text-success" : "text-destructive"}`}>
                      {Number(mov.amount) >= 0 ? "+" : ""}{formatCurrency(Number(mov.amount))}
                    </span>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => {
                      setEditId(mov.id);
                      setEditAmount(String(Math.abs(Number(mov.amount))));
                      setEditObs(mov.observation || "");
                    }}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteMovement(mov)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
