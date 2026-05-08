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
import { logAction } from "@/lib/audit-utils";

type Client = {
  id: string;
  name: string;
  phone: string | null;
  client_code: number | null;
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
    const fetch = async () => {
      const { data } = await supabase.from("clients").select("id, name, phone, client_code").order("client_code");
      setClients(data || []);
    };
    fetch();
  }, []);

  const filtered = clients.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    String(c.client_code || "").includes(search)
  );

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
      const { data: maxCode } = await supabase
        .from("clients")
        .select("client_code")
        .order("client_code", { ascending: false })
        .limit(1);
      const nextCode = (maxCode && maxCode[0]?.client_code ? Number(maxCode[0].client_code) : 0) + 1;
      const { data: { session } } = await supabase.auth.getSession();
      const { data, error } = await supabase.from("clients").insert({
        name: form.name.trim(),
        phone: form.phone || null,
        notes: form.notes || null,
        client_code: nextCode,
        full_name: form.full_name || null,
        address: form.address || null,
        doc_primary_type: form.doc_primary_type || null,
        doc_primary_number: form.doc_primary_number || null,
        doc_secondary_type: form.doc_secondary_type || null,
        doc_secondary_number: form.doc_secondary_number || null,
        user_id: session?.user?.id,
      } as any).select().single();
      setSaving(false);
      if (error || !data) { toast.error("Erro ao cadastrar cliente"); return; }
      createdId = (data as any).id;
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

      <p className="mb-3 text-sm text-muted-foreground">Ou selecione um cliente existente:</p>

      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Buscar por nome ou código..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            message={search ? "Nenhum cliente encontrado" : "Nenhum cliente cadastrado"}
            description={search ? "Tente outro nome ou código." : "Cadastre um cliente para começar."}
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
