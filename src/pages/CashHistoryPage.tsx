import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/loan-utils";
import {
  updateCashBalance,
  deleteCashMovement,
  getMovementTypeLabel,
  getMovementTypeColor,
  CashMovement,
} from "@/lib/cash-utils";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

function getDayLabel(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  if (isToday(date)) return "Hoje";
  if (isYesterday(date)) return "Ontem";
  return format(date, "EEEE, dd/MM/yyyy", { locale: ptBR });
}

type MovementWithClient = CashMovement & { clients?: { name: string } | null };

type GroupedDay = {
  date: string;
  label: string;
  movements: MovementWithClient[];
};

export default function CashHistoryPage() {
  const navigate = useNavigate();
  const [movements, setMovements] = useState<MovementWithClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState("all");
  const [filterClient, setFilterClient] = useState("");
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);

  // Edit
  const [editId, setEditId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editObs, setEditObs] = useState("");

  const fetchData = async () => {
    let query = supabase
      .from("cash_movements")
      .select("*, clients(name)")
      .order("created_at", { ascending: false })
      .limit(500);

    if (filterType !== "all") query = query.eq("type", filterType);
    if (filterClient && filterClient !== "all") query = query.eq("client_id", filterClient);

    const { data } = await query;
    setMovements((data as any) || []);
    setLoading(false);
  };

  useEffect(() => {
    supabase.from("clients").select("id, name").order("name").then(({ data }) => setClients(data || []));
  }, []);

  useEffect(() => { fetchData(); }, [filterType, filterClient]);

  const groupedDays: GroupedDay[] = (() => {
    const grouped: Record<string, MovementWithClient[]> = {};
    for (const mov of movements) {
      const day = format(new Date(mov.created_at), "yyyy-MM-dd");
      if (!grouped[day]) grouped[day] = [];
      grouped[day].push(mov);
    }
    return Object.entries(grouped)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, movs]) => ({
        date,
        label: getDayLabel(date),
        movements: movs,
      }));
  })();

  const handleDelete = async (mov: MovementWithClient) => {
    if (!confirm("Excluir movimentação e reverter saldo?")) return;
    const reverseMap: Record<string, any> = {
      emprestimo: { available_cash: Number(mov.amount), money_lent: -Number(mov.amount) },
      recebimento_normal: { available_cash: -Number(mov.amount) },
      recebimento_multa: { available_cash: -Number(mov.amount), penalty_receivable: Number(mov.amount) },
      entrada_manual: { available_cash: -Number(mov.amount) },
      saida_manual: { available_cash: -Number(mov.amount) },
      ajuste_manual: { available_cash: -Number(mov.amount) },
    };
    await updateCashBalance(reverseMap[mov.type] || {});
    await deleteCashMovement(mov.id);
    toast.success("Movimentação excluída!");
    fetchData();
  };

  const handleEdit = async () => {
    if (!editId) return;
    const newAmount = parseFloat(editAmount);
    if (isNaN(newAmount)) { toast.error("Valor inválido"); return; }
    const mov = movements.find(m => m.id === editId);
    if (!mov) return;
    const diff = newAmount - Number(mov.amount);
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

  return (
    <div className="mx-auto max-w-lg p-4">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-2">
        <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
      </Button>
      <h1 className="mb-4 text-2xl font-bold">Histórico de Movimentações</h1>

      {/* Filters */}
      <div className="mb-4 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Tipo</Label>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="emprestimo">Empréstimo</SelectItem>
                <SelectItem value="recebimento_normal">Recebimento Normal</SelectItem>
                <SelectItem value="recebimento_multa">Recebimento Multa</SelectItem>
                <SelectItem value="entrada_manual">Entrada Manual</SelectItem>
                <SelectItem value="saida_manual">Saída Manual</SelectItem>
                <SelectItem value="ajuste_manual">Ajuste Manual</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Cliente</Label>
            <Select value={filterClient} onValueChange={setFilterClient}>
              <SelectTrigger><SelectValue placeholder="Todos" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Edit dialog */}
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
            <Button onClick={handleEdit} className="w-full">Salvar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {loading ? (
        <p className="text-center text-muted-foreground">Carregando...</p>
      ) : groupedDays.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">Nenhuma movimentação encontrada</p>
      ) : (
        <div className="space-y-4">
          {groupedDays.map((group) => (
            <div key={group.date}>
              <p className="text-xs font-semibold text-muted-foreground uppercase mb-1 capitalize">{group.label}</p>
              <div className="space-y-2">
                {group.movements.map((mov) => (
                  <Card key={mov.id}>
                    <CardContent className="p-3 flex items-center justify-between">
                      <div className="flex-1">
                        <p className={`text-sm font-medium ${getMovementTypeColor(mov.type)}`}>
                          {getMovementTypeLabel(mov.type)}
                        </p>
                        {mov.clients?.name && <p className="text-xs text-muted-foreground">{mov.clients.name}</p>}
                        {mov.observation && <p className="text-xs text-muted-foreground">{mov.observation}</p>}
                        <p className="text-xs text-muted-foreground">{format(new Date(mov.created_at), "HH:mm")}</p>
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
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDelete(mov)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
