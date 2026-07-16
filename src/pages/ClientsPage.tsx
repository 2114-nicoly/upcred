import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Link, useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Users, Plus, Search, ChevronRight, Pencil, Archive, ArrowDownAZ, Filter, Layers, ArchiveRestore } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ListSkeleton, EmptyState } from "@/components/LoadingSkeleton";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/loan-utils";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import WorkerFilterSelect from "@/components/WorkerFilterSelect";
import ClientForm, { ClientFormValues, emptyClientForm, validateClientForm } from "@/components/ClientForm";
import ClientAttachments from "@/components/ClientAttachments";
import PendingClientAttachments, { type PendingAttachment } from "@/components/PendingClientAttachments";
import { uploadPendingAttachments } from "@/lib/attachment-upload";

import { logAction, requireAudit, AuditRequiredError } from "@/lib/audit-utils";

type Client = {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  client_code: number | null;
  worker_id: string | null;
  admin_id: string | null;
  doc_primary_number?: string | null;
  doc_secondary_number?: string | null;
};

type LoanSummary = {
  client_id: string;
  count: number;
  total: number;
};

export default function ClientsPage() {
  const { isAdmin, isSuperAdmin } = useAuth();
  const { selectedAdminId, selectedWorkerId, workers, admins } = useWorkerFilter();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQ = searchParams.get("q") ?? "";
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [loanSummaries, setLoanSummaries] = useState<Record<string, LoanSummary>>({});
  const [search, setSearch] = useState(initialQ);
  const [open, setOpen] = useState(false);
  const [groupByWorker, setGroupByWorker] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [form, setForm] = useState<ClientFormValues>(emptyClientForm);
  const [newClientWorkerId, setNewClientWorkerId] = useState<string>("");
  const [sortAlpha, setSortAlpha] = useState(false);
  const [filterActive, setFilterActive] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [retryQueue, setRetryQueue] = useState<{ clientId: string; items: PendingAttachment[] } | null>(null);
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [archivedClients, setArchivedClients] = useState<(Client & { archived_at: string | null })[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);

  const fetchClients = async () => {
    const { data } = await supabase.from("clients").select("*").is("archived_at", null).order("client_code");
    setClients(data || []);
    setLoading(false);

    const { data: loans } = await supabase
      .from("loans")
      .select("client_id, total_amount, status, remaining_balance")
      .not("status", "in", "(paid,cancelled,renegotiated)")
      .gt("remaining_balance", 0.01);

    const summaries: Record<string, LoanSummary> = {};
    (loans || []).forEach((l: any) => {
      if (!summaries[l.client_id]) summaries[l.client_id] = { client_id: l.client_id, count: 0, total: 0 };
      summaries[l.client_id].count++;
      summaries[l.client_id].total += Number(l.total_amount);
    });
    setLoanSummaries(summaries);
  };

  useEffect(() => { fetchClients(); }, []);

  const getNextClientCode = async () => {
    const { data } = await supabase
      .from("clients")
      .select("client_code")
      .order("client_code", { ascending: false })
      .limit(1);
    return (data && data[0]?.client_code ? Number(data[0].client_code) : 0) + 1;
  };

  const handleCreate = async (force = false) => {
    const err = validateClientForm(form);
    if (err) { toast.error(err); return; }
    if (isAdmin && !newClientWorkerId) {
      toast.error("Selecione o trabalhador responsável");
      return;
    }

    if (!force) {
      const trimmedName = form.name.trim();
      const { data: dupes } = await supabase
        .from("clients")
        .select("id, name, phone")
        .or(form.phone ? `name.ilike.${trimmedName},phone.eq.${form.phone}` : `name.ilike.${trimmedName}`);
      if (dupes && dupes.length > 0) {
        const ok = confirm(`Cliente parecido encontrado: ${dupes[0].name}${dupes[0].phone ? ` (${dupes[0].phone})` : ""}.\n\nDeseja criar mesmo assim?`);
        if (!ok) return;
      }
    }

    let createdId: string | null = null;
    if (isAdmin) {
      const { data, error } = await supabase.rpc("admin_create_client" as any, {
        p_name: form.name.trim(),
        p_phone: form.phone || null,
        p_notes: form.notes || null,
        p_worker_id: newClientWorkerId,
        p_full_name: form.full_name || null,
        p_address: form.address || null,
        p_doc_primary_type: form.doc_primary_type || null,
        p_doc_primary_number: form.doc_primary_number || null,
        p_doc_secondary_type: form.doc_secondary_type || null,
        p_doc_secondary_number: form.doc_secondary_number || null,
      });
      if (error) { toast.error(error.message || "Erro ao cadastrar cliente"); return; }
      createdId = data as any;
    } else {
      // trabalhador: vínculo automático ao próprio worker + admin responsável
      const { data, error } = await supabase.rpc("worker_create_client" as any, {
        p_name: form.name.trim(),
        p_phone: form.phone || null,
        p_notes: form.notes || null,
        p_full_name: form.full_name || null,
        p_address: form.address || null,
        p_doc_primary_type: form.doc_primary_type || null,
        p_doc_primary_number: form.doc_primary_number || null,
        p_doc_secondary_type: form.doc_secondary_type || null,
        p_doc_secondary_number: form.doc_secondary_number || null,
      });
      if (error) { toast.error(error.message || "Erro ao cadastrar cliente"); return; }
      createdId = data as any;
    }
    if (createdId) logAction("criar_cliente", "client", createdId, null, { name: form.name, full_name: form.full_name });
    toast.success("Cliente cadastrado!");

    if (createdId && pendingAttachments.length > 0) {
      const res = await uploadPendingAttachments(createdId, pendingAttachments);
      if (res.failed.length > 0) {
        toast.error(
          `Falha ao enviar ${res.failed.length} arquivo(s): ${res.failed.map((f) => f.item.name).join(", ")}`,
          { duration: 8000 }
        );
        setRetryQueue({ clientId: createdId, items: res.failed.map((f) => f.item) });
        setPendingAttachments(res.failed.map((f) => f.item));
        fetchClients();
        return; // keep dialog open for retry
      }
      if (res.ok.length > 0) toast.success(`${res.ok.length} arquivo(s) enviado(s)`);
    }
    setForm(emptyClientForm); setNewClientWorkerId(""); setOpen(false);
    setPendingAttachments([]); setRetryQueue(null);
    fetchClients();
  };

  const handleRetryUploads = async () => {
    if (!retryQueue) return;
    const res = await uploadPendingAttachments(retryQueue.clientId, retryQueue.items);
    if (res.failed.length > 0) {
      toast.error(`Ainda falharam: ${res.failed.map((f) => f.item.name).join(", ")}`);
      setRetryQueue({ clientId: retryQueue.clientId, items: res.failed.map((f) => f.item) });
      setPendingAttachments(res.failed.map((f) => f.item));
      return;
    }
    toast.success(`${res.ok.length} arquivo(s) enviado(s)`);
    setForm(emptyClientForm); setNewClientWorkerId(""); setOpen(false);
    setPendingAttachments([]); setRetryQueue(null);
    fetchClients();
  };

  const handleEdit = async () => {
    if (!editingClient) return;
    const err = validateClientForm(form);
    if (err) { toast.error(err); return; }
    const oldVal = {
      name: editingClient.name,
      phone: editingClient.phone,
      notes: editingClient.notes,
      full_name: (editingClient as any).full_name,
      address: (editingClient as any).address,
      doc_primary_type: (editingClient as any).doc_primary_type,
      doc_primary_number: (editingClient as any).doc_primary_number,
      doc_secondary_type: (editingClient as any).doc_secondary_type,
      doc_secondary_number: (editingClient as any).doc_secondary_number,
    };
    const newVal = {
      name: form.name.trim(), phone: form.phone || null, notes: form.notes || null,
      full_name: form.full_name || null, address: form.address || null,
      doc_primary_type: form.doc_primary_type || null, doc_primary_number: form.doc_primary_number || null,
      doc_secondary_type: form.doc_secondary_type || null, doc_secondary_number: form.doc_secondary_number || null,
    };
    const { error } = await supabase.from("clients").update(newVal as any).eq("id", editingClient.id);
    if (error) { toast.error("Erro ao editar"); return; }
    logAction("editar_cliente", "client", editingClient.id, oldVal, newVal);
    toast.success("Cliente atualizado!");
    setEditOpen(false); setEditingClient(null);
    setForm(emptyClientForm);
    fetchClients();
  };

  const handleArchive = async (id: string) => {
    if (!confirm("Arquivar este cliente? Ele deixará de aparecer nas listas, mas todo o histórico (empréstimos, pagamentos, caixa) será preservado.")) return;
    try {
      await requireAudit(
        "excluir_cliente", "client", id,
        { archived: false },
        { archived: true },
        "Arquivamento de cliente",
      );
    } catch (err) {
      if (err instanceof AuditRequiredError) return;
      throw err;
    }
    const { data: { session } } = await supabase.auth.getSession();
    const uid = session?.user?.id || null;
    const { error } = await supabase
      .from("clients")
      .update({ archived_at: new Date().toISOString(), archived_by: uid } as any)
      .eq("id", id);
    if (error) { toast.error("Erro ao arquivar cliente"); return; }
    toast.success("Cliente arquivado!");
    fetchClients();
  };


  const openEdit = (client: Client) => {
    setEditingClient(client);
    setForm({
      name: client.name || "",
      full_name: (client as any).full_name || "",
      phone: client.phone || "",
      address: (client as any).address || "",
      doc_primary_type: ((client as any).doc_primary_type as any) || "CPF",
      doc_primary_number: (client as any).doc_primary_number || "",
      doc_secondary_type: ((client as any).doc_secondary_type as any) || "",
      doc_secondary_number: (client as any).doc_secondary_number || "",
      notes: client.notes || "",
    });
    setEditOpen(true);
  };

  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  let filtered = !q ? clients : clients.filter((c) => {
    if (c.name.toLowerCase().includes(q)) return true;
    if (String(c.client_code || "").includes(q)) return true;
    if (qDigits && c.phone && c.phone.replace(/\D/g, "").includes(qDigits)) return true;
    if (qDigits && (c.doc_primary_number || "").replace(/\D/g, "").includes(qDigits)) return true;
    if (qDigits && (c.doc_secondary_number || "").replace(/\D/g, "").includes(qDigits)) return true;
    return false;
  });

  if (filterActive) {
    filtered = filtered.filter((c) => loanSummaries[c.id]?.count > 0);
  }

  // Hierarchical scope filter (admin → worker)
  if (isAdmin && selectedAdminId) {
    filtered = filtered.filter((c) => c.admin_id === selectedAdminId);
  }
  if (isAdmin && selectedWorkerId) {
    filtered = filtered.filter((c) => c.worker_id === selectedWorkerId);
  }

  if (sortAlpha) {
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }

  const workerName = (id: string | null) => {
    if (!id) return "Sem trabalhador";
    return workers.find((w) => w.id === id)?.nome ?? "Trabalhador removido";
  };
  const adminName = (id: string | null) => {
    if (!id) return "—";
    return admins.find((a) => a.id === id)?.nome ?? "Admin removido";
  };

  // Group by worker (and admin for super_admin)
  const grouped: Record<string, Client[]> = {};
  if (groupByWorker) {
    for (const c of filtered) {
      const k = c.worker_id || "__none__";
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(c);
    }
  }
  const groupKeys = Object.keys(grouped).sort((a, b) => workerName(a === "__none__" ? null : a).localeCompare(workerName(b === "__none__" ? null : b)));

  // 2-level grouping for super_admin: Admin > Worker
  const groupedByAdmin: Record<string, Record<string, Client[]>> = {};
  if (groupByWorker && isSuperAdmin) {
    for (const c of filtered) {
      const ak = c.admin_id || "__none__";
      const wk = c.worker_id || "__none__";
      if (!groupedByAdmin[ak]) groupedByAdmin[ak] = {};
      if (!groupedByAdmin[ak][wk]) groupedByAdmin[ak][wk] = [];
      groupedByAdmin[ak][wk].push(c);
    }
  }
  const adminKeys = Object.keys(groupedByAdmin).sort((a, b) => adminName(a === "__none__" ? null : a).localeCompare(adminName(b === "__none__" ? null : b)));

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-4 flex items-center justify-end">
        <Dialog open={open} onOpenChange={(o) => {
          setOpen(o);
          if (o && isAdmin && !newClientWorkerId && selectedWorkerId) setNewClientWorkerId(selectedWorkerId);
        }}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="mr-1 h-4 w-4" /> Novo</Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Novo Cliente</DialogTitle></DialogHeader>
            <ClientForm
              value={form}
              onChange={setForm}
              submitLabel="Cadastrar"
              onSubmit={() => handleCreate()}
              extra={
                <div className="space-y-3">
                  {isAdmin && (
                    <div>
                      <Label>Trabalhador responsável *</Label>
                      <Select value={newClientWorkerId} onValueChange={setNewClientWorkerId}>
                        <SelectTrigger><SelectValue placeholder="Selecione um trabalhador" /></SelectTrigger>
                        <SelectContent>
                          {workers.filter((w) => w.active).map((w) => (
                            <SelectItem key={w.id} value={w.id}>{w.nome} · {w.login_codigo}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {workers.filter((w) => w.active).length === 0 && (
                        <p className="text-xs text-destructive mt-1">Nenhum trabalhador ativo. Cadastre um trabalhador antes.</p>
                      )}
                    </div>
                  )}
                  <PendingClientAttachments
                    items={pendingAttachments}
                    onChange={setPendingAttachments}
                  />
                  {retryQueue && (
                    <Button type="button" variant="outline" className="w-full" onClick={handleRetryUploads}>
                      Tentar novamente ({retryQueue.items.length})
                    </Button>
                  )}
                </div>
              }
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Buscar por nome, código, telefone ou documento..."
          value={search}
          onChange={(e) => {
            const v = e.target.value;
            setSearch(v);
            const next = new URLSearchParams(searchParams);
            if (v) next.set("q", v); else next.delete("q");
            setSearchParams(next, { replace: true });
          }}
        />
      </div>

      {isAdmin && (
        <Card className="mb-3">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase">Filtro hierárquico</p>
              <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[11px]">Agrupar por trabalhador</span>
                <Switch checked={groupByWorker} onCheckedChange={setGroupByWorker} />
              </div>
            </div>
            <WorkerFilterSelect />
          </CardContent>
        </Card>
      )}

      <div className="mb-4 flex gap-3">
        <div className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2">
          <ArrowDownAZ className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs">A-Z</span>
          <Switch checked={sortAlpha} onCheckedChange={setSortAlpha} />
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs">Ativos</span>
          <Switch checked={filterActive} onCheckedChange={setFilterActive} />
        </div>
      </div>

      <div className="space-y-2">
        {loading ? (
          <ListSkeleton count={5} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            message={search ? "Nenhum cliente encontrado" : "Nenhum cliente cadastrado"}
            actionLabel={!search ? "Cadastrar cliente" : undefined}
            onAction={!search ? () => setOpen(true) : undefined}
          />
        ) : (
          (() => {
            const renderClient = (client: Client) => {
              const summary = loanSummaries[client.id];
              return (
                <Card key={client.id} className="overflow-hidden">
                  <CardContent className="flex items-center justify-between p-4">
                    <Link to={`/clients/${client.id}`} className="flex-1">
                      <div>
                        <p className="font-semibold">{client.name}</p>
                        {client.phone && <p className="text-sm text-muted-foreground">{client.phone}</p>}
                        <p className="text-[10px] text-muted-foreground">
                          Trab.: {workerName(client.worker_id)}
                          {isSuperAdmin && <> · Admin: {adminName(client.admin_id)}</>}
                        </p>
                        {summary && (
                          <p className="text-xs text-primary">
                            {summary.count} ativo{summary.count > 1 ? "s" : ""} • {formatCurrency(summary.total)}
                          </p>
                        )}
                      </div>
                    </Link>
                    <div className="flex items-center gap-1">
                      {summary && <Badge className="mr-1">{summary.count}</Badge>}
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => openEdit(client)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0" title="Arquivar cliente" onClick={() => handleArchive(client.id)}>
                        <Archive className="h-3.5 w-3.5" />
                      </Button>

                      <Link to={`/clients/${client.id}`}>
                        <ChevronRight className="h-5 w-5 text-muted-foreground" />
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              );
            };
            if (groupByWorker && isSuperAdmin) {
              return adminKeys.map((ak) => {
                const totalAdmin = Object.values(groupedByAdmin[ak]).reduce((s, arr) => s + arr.length, 0);
                const wKeys = Object.keys(groupedByAdmin[ak]).sort((a, b) => workerName(a === "__none__" ? null : a).localeCompare(workerName(b === "__none__" ? null : b)));
                return (
                  <div key={ak} className="space-y-2">
                    <p className="text-xs font-bold text-primary uppercase mt-3 px-1 border-b pb-1">
                      Admin: {adminName(ak === "__none__" ? null : ak)} ({totalAdmin})
                    </p>
                    {wKeys.map((wk) => (
                      <div key={wk} className="space-y-2 pl-2">
                        <p className="text-[11px] font-semibold text-muted-foreground uppercase mt-1 px-1">
                          ↳ {workerName(wk === "__none__" ? null : wk)} ({groupedByAdmin[ak][wk].length})
                        </p>
                        {groupedByAdmin[ak][wk].map(renderClient)}
                      </div>
                    ))}
                  </div>
                );
              });
            }
            if (groupByWorker && isAdmin) {
              return groupKeys.map((k) => (
                <div key={k} className="space-y-2">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase mt-2 px-1">
                    {workerName(k === "__none__" ? null : k)} ({grouped[k].length})
                  </p>
                  {grouped[k].map(renderClient)}
                </div>
              ));
            }
            return filtered.map(renderClient);
          })()
        )}
      </div>

      <Dialog open={editOpen} onOpenChange={(o) => { setEditOpen(o); if (!o) setEditingClient(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Editar Cliente</DialogTitle></DialogHeader>
          <ClientForm
            value={form}
            onChange={setForm}
            submitLabel="Salvar"
            onSubmit={handleEdit}
            extra={editingClient && (
              <div className="pt-2 border-t">
                <ClientAttachments clientId={editingClient.id} />
              </div>
            )}
          />
        </DialogContent>
      </Dialog>

    </div>
  );
}
