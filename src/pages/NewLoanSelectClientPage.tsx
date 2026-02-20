import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search, ChevronRight } from "lucide-react";

type Client = {
  id: string;
  name: string;
  phone: string | null;
  client_code: number | null;
};

export default function NewLoanSelectClientPage() {
  const navigate = useNavigate();
  const [clients, setClients] = useState<Client[]>([]);
  const [search, setSearch] = useState("");

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

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-4 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
        </Button>
        <h1 className="text-xl font-bold">Novo Empréstimo</h1>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">Selecione o cliente:</p>

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
              onClick={() => navigate(`/clients/${client.id}/new-loan`)}
            >
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="font-semibold">
                    {client.client_code ? <span className="mr-1 text-xs text-muted-foreground">#{client.client_code}</span> : null}
                    {client.name}
                  </p>
                  {client.phone && <p className="text-sm text-muted-foreground">{client.phone}</p>}
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground" />
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
