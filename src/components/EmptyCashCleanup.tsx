import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { Loader2, Ban, Search, Sparkles } from "lucide-react";

type Row = {
  id: string;
  cash_date: string;
  worker_id: string | null;
  admin_id: string | null;
  worker_nome: string | null;
  admin_nome: string | null;
  opened_at: string | null;
  is_empty: boolean;
  reason: string | null;
};

function todayISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export default function EmptyCashCleanup() {
  const { isSuperAdmin } = useAuth();
  const [start, setStart] = useState(todayISO(-60));
  const [end, setEnd] = useState(todayISO(0));
  const [adminId, setAdminId] = useState<string>("__all__");
  const [workerId, setWorkerId] = useState<string>("__all__");
  const [admins, setAdmins] = useState<Array<{ id: string; nome: string }>>([]);
  const [workers, setWorkers] = useState<Array<{ id: string; nome: string; parent_admin_id: string | null }>>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    (async () => {
      if (isSuperAdmin) {
        const { data } = await supabase.rpc("super_admin_list_admins" as any);
        setAdmins(((data as any[]) ?? []).map((a) => ({ id: a.id, nome: a.nome })));
      }
    })();
  }, [isSuperAdmin]);

  useEffect(() => {
    (async () => {
      const p_admin_id = isSuperAdmin ? (adminId === "__all__" ? null : adminId) : null;
      const { data: ws } = await supabase.rpc("list_workers_by_admin" as any, {
        p_admin_id,
        p_include_archived: true,
      });
      setWorkers(((ws as any[]) ?? []).map((w) => ({
        id: w.id, nome: w.nome, parent_admin_id: w.parent_admin_id,
      })));
    })();
  }, [isSuperAdmin, adminId]);

  const emptyRows = useMemo(() => (rows ?? []).filter((r) => r.is_empty), [rows]);
  const nonEmptyRows = useMemo(() => (rows ?? []).filter((r) => !r.is_empty), [rows]);
  const allWorkersLabel = isSuperAdmin && adminId === "__all__" ? "Todos os trabalhadores" : "Toda a equipe";
  const allEmptySelected = emptyRows.length > 0 && emptyRows.every((r) => selected.has(r.id));

  function toggleOne(id: string, value: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (value) next.add(id); else next.delete(id);
      return next;
    });
  }
  function toggleAllEmpty(value: boolean) {
    if (!value) { setSelected(new Set()); return; }
    setSelected(new Set(emptyRows.map((r) => r.id)));
  }

  async function preview() {
    setLoading(true);
    setRows(null);
    setSelected(new Set());
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.rpc("admin_find_empty_daily_cash" as any, {
        p_start: start,
        p_end: end,
        p_admin_id: adminId === "__all__" ? null : adminId,
        p_worker_id: workerId === "__all__" ? null : workerId,
      });
      if (error) throw error;
      setRows((data as Row[]) ?? []);
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Erro ao buscar caixas");
      toast({ title: "Erro ao buscar", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function execute() {
    setConfirmOpen(false);
    setCleaning(true);
    setErrorMsg(null);
    try {
      const ids = Array.from(selected);
      const { data, error } = await supabase.rpc("admin_cleanup_empty_daily_cash_ids" as any, {
        p_cash_ids: ids,
      });
      if (error) throw error;
      toast({ title: "Cancelamento concluído", description: `${Number(data ?? 0)} caixa(s) vazios cancelados.` });
      setSelected(new Set());
      await preview();
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Erro no cancelamento");
      toast({ title: "Erro no cancelamento", description: e?.message, variant: "destructive" });
    } finally {
      setCleaning(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> Cancelar Caixas Vazios
        </CardTitle>
        <CardDescription className="text-xs">
          Lista todos os caixas <strong>abertos</strong> no período. Selecione os marcados como “vazio” para cancelar
          (status <code>cancelled_empty</code>) — nenhuma movimentação é apagada e o dia volta ao estado neutro.
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
            <Select
              value={adminId}
              onValueChange={(v) => { setAdminId(v); setWorkerId("__all__"); }}
            >
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
              <SelectItem value="__all__">{allWorkersLabel}</SelectItem>
              {workers.map((w) => <SelectItem key={w.id} value={w.id}>{w.nome}</SelectItem>)}
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
            disabled={cleaning || selected.size === 0}
          >
            {cleaning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
            Cancelar {selected.size ? `(${selected.size})` : ""}
          </Button>
        </div>

        {errorMsg && (
          <div className="text-xs rounded border border-destructive/40 bg-destructive/10 text-destructive p-2">
            {errorMsg}
          </div>
        )}

        {rows !== null && (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
              <span><strong className="text-foreground">{rows.length}</strong> aberto(s)</span>
              <span>·</span>
              <span><strong className="text-success">{emptyRows.length}</strong> vazio(s)</span>
              <span>·</span>
              <span><strong>{nonEmptyRows.length}</strong> com movimento</span>
              <span>·</span>
              <span><strong className="text-destructive">{selected.size}</strong> selecionado(s)</span>
            </div>

            {emptyRows.length > 0 && (
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox
                  checked={allEmptySelected}
                  onCheckedChange={(v) => toggleAllEmpty(Boolean(v))}
                />
                <span>Selecionar todos os vazios ({emptyRows.length})</span>
              </label>
            )}

            <div className="border rounded text-xs max-h-72 overflow-auto">
              {rows.length === 0 ? (
                <p className="p-3 text-muted-foreground text-center">
                  Nenhum caixa aberto encontrado no período com os filtros atuais.
                </p>
              ) : (
                <ul className="divide-y">
                  {rows.map((it) => (
                    <li key={it.id} className="p-2 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {it.is_empty ? (
                          <Checkbox
                            checked={selected.has(it.id)}
                            onCheckedChange={(v) => toggleOne(it.id, Boolean(v))}
                          />
                        ) : (
                          <span className="inline-block h-4 w-4 shrink-0" />
                        )}
                        <span className="font-mono">{it.cash_date}</span>
                        <span className="text-muted-foreground truncate">
                          {it.worker_nome ?? "—"}
                          {isSuperAdmin && it.admin_nome ? ` · ${it.admin_nome}` : ""}
                        </span>
                      </div>
                      {it.is_empty ? (
                        <Badge variant="secondary" className="bg-success/15 text-success border-success/30">
                          vazio
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] max-w-[55%] truncate" title={it.reason ?? ""}>
                          {it.reason ?? "com movimento"}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar cancelamento</AlertDialogTitle>
            <AlertDialogDescription>
              Serão marcados como <strong>cancelled_empty</strong> <strong>{selected.size}</strong> caixa(s) selecionado(s).
              Nenhuma movimentação será apagada — o dia volta ao estado neutro e pode ser reaberto manualmente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={execute} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Cancelar caixas
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
