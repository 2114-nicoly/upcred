import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { Loader2, Trash2, Search, Sparkles } from "lucide-react";

type Empty = {
  id: string;
  cash_date: string;
  worker_id: string | null;
  admin_id: string | null;
  worker_nome: string | null;
  admin_nome: string | null;
  opened_at: string | null;
};

function todayISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export default function EmptyCashCleanup() {
  const { isSuperAdmin } = useAuth();
  const [start, setStart] = useState(todayISO(-60));
  const [end, setEnd] = useState(todayISO(-1));
  const [adminId, setAdminId] = useState<string>("__all__");
  const [workerId, setWorkerId] = useState<string>("__all__");
  const [admins, setAdmins] = useState<Array<{ id: string; nome: string }>>([]);
  const [workers, setWorkers] = useState<Array<{ id: string; nome: string; parent_admin_id: string | null }>>([]);
  const [items, setItems] = useState<Empty[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    (async () => {
      if (isSuperAdmin) {
        const { data } = await supabase.rpc("super_admin_list_admins" as any);
        setAdmins(((data as any[]) ?? []).map((a) => ({ id: a.id, nome: a.nome })));
      }
      const { data: ws } = await supabase.rpc("list_workers_by_admin" as any, { p_admin_id: null });
      setWorkers(((ws as any[]) ?? []).map((w) => ({ id: w.id, nome: w.nome, parent_admin_id: w.parent_admin_id })));
    })();
  }, [isSuperAdmin]);

  const filteredWorkers = adminId === "__all__"
    ? workers
    : workers.filter((w) => w.parent_admin_id === adminId);

  async function preview() {
    setLoading(true);
    setItems(null);
    try {
      const { data, error } = await supabase.rpc("admin_find_empty_daily_cash" as any, {
        p_start: start,
        p_end: end,
        p_admin_id: adminId === "__all__" ? null : adminId,
        p_worker_id: workerId === "__all__" ? null : workerId,
      });
      if (error) throw error;
      setItems((data as Empty[]) ?? []);
    } catch (e: any) {
      toast({ title: "Erro ao buscar", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function execute() {
    setConfirmOpen(false);
    setCleaning(true);
    try {
      const { data, error } = await supabase.rpc("admin_cleanup_empty_daily_cash" as any, {
        p_start: start,
        p_end: end,
        p_admin_id: adminId === "__all__" ? null : adminId,
        p_worker_id: workerId === "__all__" ? null : workerId,
      });
      if (error) throw error;
      toast({ title: "Limpeza concluída", description: `${Number(data ?? 0)} caixa(s) vazios removidos.` });
      setItems(null);
      await preview();
    } catch (e: any) {
      toast({ title: "Erro na limpeza", description: e.message, variant: "destructive" });
    } finally {
      setCleaning(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> Limpar Caixas Vazios
        </CardTitle>
        <CardDescription className="text-xs">
          Remove caixas abertos sem nenhuma movimentação real (sem pagamentos, empréstimos, marcações ou eventos).
          Dias com qualquer atividade são preservados.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">De</Label>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">Até</Label>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="h-8 text-xs" />
          </div>
        </div>

        {isSuperAdmin && (
          <div>
            <Label className="text-xs">Administrador</Label>
            <Select value={adminId} onValueChange={(v) => { setAdminId(v); setWorkerId("__all__"); }}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos os admins</SelectItem>
                {admins.map((a) => <SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}

        <div>
          <Label className="text-xs">Trabalhador</Label>
          <Select value={workerId} onValueChange={setWorkerId}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Toda a equipe</SelectItem>
              {filteredWorkers.map((w) => <SelectItem key={w.id} value={w.id}>{w.nome}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1 gap-2" onClick={preview} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Pré-visualizar
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="flex-1 gap-2"
            onClick={() => setConfirmOpen(true)}
            disabled={cleaning || !items || items.length === 0}
          >
            {cleaning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Limpar {items?.length ? `(${items.length})` : ""}
          </Button>
        </div>

        {items !== null && (
          <div className="border rounded text-xs max-h-64 overflow-auto">
            {items.length === 0 ? (
              <p className="p-3 text-muted-foreground text-center">Nenhum caixa vazio encontrado no período.</p>
            ) : (
              <ul className="divide-y">
                {items.map((it) => (
                  <li key={it.id} className="p-2 flex justify-between gap-2">
                    <span className="font-mono">{it.cash_date}</span>
                    <span className="text-muted-foreground truncate">
                      {it.worker_nome ?? "—"}{isSuperAdmin && it.admin_nome ? ` · ${it.admin_nome}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar limpeza</AlertDialogTitle>
            <AlertDialogDescription>
              Serão removidos <strong>{items?.length ?? 0}</strong> caixa(s) vazio(s) entre {start} e {end}.
              Esta ação não pode ser desfeita, mas só remove caixas sem nenhuma movimentação real.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={execute} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Confirmar limpeza
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
