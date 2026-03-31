import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Users, Plus, Search, ChevronRight, Pencil, Trash2, ArrowDownAZ, Filter } from "lucide-react";
import { ListSkeleton, EmptyState } from "@/components/LoadingSkeleton";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/loan-utils";

type Client = {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  client_code: number | null;
};

type LoanSummary = {
  client_id: string;
  count: number;
  total: number;
};

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [loanSummaries, setLoanSummaries] = useState<Record<string, LoanSummary>>({});
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [sortAlpha, setSortAlpha] = useState(false);
  const [filterActive, setFilterActive] = useState(false);

  const fetchClients = async () => {
    const { data } = await supabase.from("clients").select("*").order("client_code");
    setClients(data || []);
    setLoading(false);

    const { data: loans } = await supabase
      .from("loans")
      .select("client_id, total_amount, status")
      .neq("status", "paid");

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

  const handleCreate = async () => {
    if (!name.trim()) { toast.error("Nome é obrigatório"); return; }
    const nextCode = await getNextClientCode();
    const { error } = await supabase.from("clients").insert({
      name: name.trim(), phone: phone || null, notes: notes || null, client_code: nextCode,
    });
    if (error) { toast.error("Erro ao cadastrar cliente"); return; }
    toast.success(`Cliente #${nextCode} cadastrado!`);
    setName(""); setPhone(""); setNotes(""); setOpen(false);
    fetchClients();
  };

  const handleEdit = async () => {
    if (!editingClient) return;
    const { error } = await supabase.from("clients").update({
      name: name.trim(), phone: phone || null, notes: notes || null,
    }).eq("id", editingClient.id);
    if (error) { toast.error("Erro ao editar"); return; }
    toast.success("Cliente atualizado!");
    setEditOpen(false); setEditingClient(null);
    setName(""); setPhone(""); setNotes("");
    fetchClients();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Tem certeza que deseja excluir este cliente? Todos os empréstimos serão removidos.")) return;
    await supabase.from("clients").delete().eq("id", id);
    toast.success("Cliente excluído!");
    fetchClients();
  };

  const openEdit = (client: Client) => {
    setEditingClient(client);
    setName(client.name);
    setPhone(client.phone || "");
    setNotes(client.notes || "");
    setEditOpen(true);
  };

  let filtered = clients.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    String(c.client_code || "").includes(search)
  );

  if (filterActive) {
    filtered = filtered.filter((c) => loanSummaries[c.id]?.count > 0);
  }

  if (sortAlpha) {
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-4 flex items-center justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="mr-1 h-4 w-4" /> Novo</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Novo Cliente</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div><Label>Nome *</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome completo" /></div>
              <div><Label>Telefone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(00) 00000-0000" /></div>
              <div><Label>Observações</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observações..." /></div>
              <Button onClick={handleCreate} className="w-full">Cadastrar</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Buscar por nome..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

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
          filtered.map((client) => {
            const summary = loanSummaries[client.id];
            return (
              <Card key={client.id} className="overflow-hidden">
                <CardContent className="flex items-center justify-between p-4">
                  <Link to={`/clients/${client.id}`} className="flex-1">
                    <div>
                      <p className="font-semibold">
                        {client.client_code ? <span className="mr-1 text-xs text-muted-foreground">#{client.client_code}</span> : null}
                        {client.name}
                      </p>
                      {client.phone && <p className="text-sm text-muted-foreground">{client.phone}</p>}
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
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={() => handleDelete(client.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    <Link to={`/clients/${client.id}`}>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      <Dialog open={editOpen} onOpenChange={(o) => { setEditOpen(o); if (!o) setEditingClient(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Cliente</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label>Nome *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><Label>Telefone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
            <div><Label>Observações</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            <Button onClick={handleEdit} className="w-full">Salvar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
