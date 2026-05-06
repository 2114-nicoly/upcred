import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Search, ChevronRight, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { getActiveLoanForClient } from "@/lib/loan-utils";

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

  const [clients, setClients] = useState<Client[]>([]);
  const [search, setSearch] = useState("");

  // New client form
  const [newClientMode, setNewClientMode] = useState(showNewClient);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
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
    if (!name.trim()) { toast.error("Nome é obrigatório"); return; }

    if (!force) {
      const trimmedName = name.trim();
      const { data: dupes } = await supabase
        .from("clients")
        .select("id, name, phone")
        .or(phone ? `name.ilike.${trimmedName},phone.eq.${phone}` : `name.ilike.${trimmedName}`);
      if (dupes && dupes.length > 0) {
        const ok = confirm(`Cliente parecido encontrado: ${dupes[0].name}${dupes[0].phone ? ` (${dupes[0].phone})` : ""}.\n\nDeseja criar mesmo assim?`);
        if (!ok) return;
      }
    }

    setSaving(true);
    const { data: maxCode } = await supabase
      .from("clients")
      .select("client_code")
      .order("client_code", { ascending: false })
      .limit(1);
    const nextCode = (maxCode && maxCode[0]?.client_code ? Number(maxCode[0].client_code) : 0) + 1;

    const { data: { session } } = await supabase.auth.getSession();
    const { data, error } = await supabase.from("clients").insert({
      name: name.trim(), phone: phone || null, notes: notes || null, client_code: nextCode,
      user_id: session?.user?.id,
    } as any).select().single();

    setSaving(false);
    if (error || !data) { toast.error("Erro ao cadastrar cliente"); return; }
    toast.success("Cliente cadastrado!");
    navigate(`/clients/${data.id}/new-loan`);
  };

  if (newClientMode) {
    return (
      <div className="mx-auto max-w-lg p-4">
        <div className="space-y-4">
          <div><Label>Nome *</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome completo" /></div>
          <div><Label>Telefone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(00) 00000-0000" /></div>
          <div><Label>Observações</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observações..." /></div>
          <Button onClick={() => handleCreateClient()} disabled={saving} className="w-full">
            {saving ? "Salvando..." : "Cadastrar e Criar Empréstimo"}
          </Button>
        </div>
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
          <p className="py-8 text-center text-muted-foreground">Nenhum cliente encontrado</p>
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
