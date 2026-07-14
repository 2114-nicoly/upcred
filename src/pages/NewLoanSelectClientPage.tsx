import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Search, ChevronRight, AlertTriangle, Users } from "lucide-react";
import { EmptyState } from "@/components/LoadingSkeleton";
import { toast } from "sonner";
import { getActiveLoanForClient } from "@/lib/loan-utils";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import ClientForm, { ClientFormValues, emptyClientForm, validateClientForm } from "@/components/ClientForm";
import PendingClientAttachments, { type PendingAttachment } from "@/components/PendingClientAttachments";
import { uploadPendingAttachments } from "@/lib/attachment-upload";
import { logAction } from "@/lib/audit-utils";

type Client = {
  id: string;
  name: string;
  phone: string | null;
  client_code: number | null;
  doc_primary_number: string | null;
  doc_secondary_number: string | null;
};


export default function NewLoanSelectClientPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const showNewClient = searchParams.get("new_client") === "true";
  const { isAdmin } = useAuth();
  const { workers } = useWorkerFilter();

  const [clients, setClients] = useState<Client[]>([]);
  const [search, setSearch] = useState("");

  // New client form
  const [newClientMode, setNewClientMode] = useState(showNewClient);
  const [form, setForm] = useState<ClientFormValues>(emptyClientForm);
  const [newClientWorkerId, setNewClientWorkerId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Active-loan blocking dialog
  const [activeBlockDialog, setActiveBlockDialog] = useState<{
    clientId: string;
    clientName: string;
    activeLoanId: string;
  } | null>(null);

  useEffect(() => {
    const fetchEligible = async () => {
      // 1) buscar todos os clientes do escopo
      const { data: clientRows } = await supabase
        .from("clients")
        .select("id, name, phone, client_code, doc_primary_number, doc_secondary_number")
        .order("client_code");
      // 2) buscar empréstimos ativos para excluir esses clientes
      const { data: activeLoans } = await supabase
        .from("loans")
        .select("client_id, status, remaining_balance")
        .not("status", "in", "(paid,cancelled,renegotiated)")
        .gt("remaining_balance", 0.01);
      const blocked = new Set((activeLoans || []).map((l: any) => l.client_id));
      const eligible = (clientRows || []).filter((c: any) => !blocked.has(c.id));
      setClients(eligible as Client[]);
    };
    fetchEligible();
  }, []);

  const filtered = clients.filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const onlyDigits = q.replace(/\D/g, "");
    return (
      c.name.toLowerCase().includes(q) ||
      String(c.client_code || "").includes(q) ||
      (c.phone || "").toLowerCase().includes(q) ||
      (onlyDigits && (c.phone || "").replace(/\D/g, "").includes(onlyDigits)) ||
      (c.doc_primary_number || "").toLowerCase().includes(q) ||
      (c.doc_secondary_number || "").toLowerCase().includes(q)
    );
  });


  const handleSelectClient = async (client: Client) => {
    const active = await getActiveLoanForClient(client.id);
    if (active) {
      setActiveBlockDialog({ clientId: client.id, clientName: client.name, activeLoanId: active.id });
      return;
    }
    navigate(`/clients/${client.id}/new-loan`);
  };

  const handleCreateClient = async (force = false) => {
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

    setSaving(true);
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
      setSaving(false);
      if (error) { toast.error(error.message || "Erro ao cadastrar cliente"); return; }
      createdId = data as any;
    } else {
      // trabalhador: vincula automaticamente a si próprio + admin responsável
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
      setSaving(false);
      if (error || !data) { toast.error(error?.message || "Erro ao cadastrar cliente"); return; }
      createdId = data as any;
    }

    if (createdId) {
      logAction("criar_cliente", "client", createdId, null, { name: form.name, full_name: form.full_name, origin: "novo_emprestimo" });
      toast.success("Cliente cadastrado!");
      navigate(`/clients/${createdId}/new-loan`);
    }
  };

  if (newClientMode) {
    return (
      <div className="mx-auto max-w-lg p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Novo cliente</h2>
          <Button variant="ghost" size="sm" onClick={() => setNewClientMode(false)}>Voltar</Button>
        </div>
        <ClientForm
          value={form}
          onChange={setForm}
          submitLabel={saving ? "Salvando..." : "Cadastrar e Criar Empréstimo"}
          onSubmit={() => handleCreateClient()}
          extra={
            isAdmin ? (
              <div>
                <Label>Trabalhador responsável *</Label>
                <Select value={newClientWorkerId} onValueChange={setNewClientWorkerId}>
                  <SelectTrigger><SelectValue placeholder="Selecione o trabalhador" /></SelectTrigger>
                  <SelectContent>
                    {workers.filter((w) => w.active).map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.nome}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg p-4">

      <div className="mb-3 flex gap-2">
        <Button variant="outline" className="flex-1" onClick={() => setNewClientMode(true)}>
          Cadastrar novo cliente
        </Button>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">
        Ou selecione um cliente <strong>sem empréstimo ativo</strong>:
      </p>

      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Buscar por nome, código, telefone ou documento..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            message={search ? "Nenhum cliente elegível encontrado" : "Nenhum cliente sem empréstimo ativo"}
            description={search ? "Tente outro termo de busca." : "Cadastre um novo cliente para liberar um empréstimo."}
            actionLabel={!search ? "Cadastrar novo cliente" : undefined}
            onAction={!search ? () => setNewClientMode(true) : undefined}

          />

        ) : (
          filtered.map((client) => (
            <Card
              key={client.id}
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => handleSelectClient(client)}
            >
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="font-semibold">{client.name}</p>
                  {client.phone && <p className="text-sm text-muted-foreground">{client.phone}</p>}
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground" />
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Dialog open={!!activeBlockDialog} onOpenChange={(o) => !o && setActiveBlockDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Cliente já possui empréstimo ativo
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{activeBlockDialog?.clientName}</span> já tem um empréstimo em aberto.
            Cada cliente pode ter apenas <strong>1 empréstimo ativo</strong> por vez.
          </p>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full"
              onClick={() => {
                if (!activeBlockDialog) return;
                navigate(`/loans/${activeBlockDialog.activeLoanId}`);
              }}
            >
              Abrir empréstimo ativo
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => {
                if (!activeBlockDialog) return;
                navigate(`/clients/${activeBlockDialog.clientId}/new-loan?renewFrom=${activeBlockDialog.activeLoanId}`);
              }}
            >
              Renovar
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setActiveBlockDialog(null)}>Cancelar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
