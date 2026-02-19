import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Check, X, Shield } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

type RouteRequest = {
  id: string;
  worker_name: string;
  status: string;
  assigned_route_number: string | null;
  created_at: string;
};

type Route = {
  id: string;
  route_number: string;
  worker_name: string;
  status: string;
  created_at: string;
};

export default function AdminPage() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<RouteRequest[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [routeInputs, setRouteInputs] = useState<Record<string, string>>({});

  const fetchData = async () => {
    const { data: req } = await supabase.from("route_requests").select("*").order("created_at", { ascending: false });
    setRequests((req as RouteRequest[]) || []);
    const { data: rt } = await supabase.from("routes").select("*").order("route_number");
    setRoutes((rt as Route[]) || []);
  };

  useEffect(() => { fetchData(); }, []);

  const generateRouteNumber = () => {
    const existing = new Set(routes.map((r) => r.route_number));
    for (let i = 1; i <= 999; i++) {
      const num = String(i).padStart(3, "0");
      if (!existing.has(num)) return num;
    }
    return null;
  };

  const handleApprove = async (req: RouteRequest) => {
    const routeNum = routeInputs[req.id] || generateRouteNumber();
    if (!routeNum) {
      toast.error("Não foi possível gerar número de rota");
      return;
    }

    const { error: routeError } = await supabase.from("routes").insert({
      route_number: routeNum,
      worker_name: req.worker_name,
    });

    if (routeError) {
      toast.error("Erro ao criar rota (número pode já existir)");
      return;
    }

    await supabase.from("route_requests").update({
      status: "approved",
      assigned_route_number: routeNum,
    }).eq("id", req.id);

    toast.success(`Rota ${routeNum} criada para ${req.worker_name}!`);
    fetchData();
  };

  const handleReject = async (id: string) => {
    await supabase.from("route_requests").update({ status: "rejected" }).eq("id", id);
    toast.info("Solicitação rejeitada");
    fetchData();
  };

  const pendingRequests = requests.filter((r) => r.status === "pending");
  const processedRequests = requests.filter((r) => r.status !== "pending");

  return (
    <div className="mx-auto max-w-lg p-4">
      <Button variant="ghost" size="sm" onClick={() => navigate("/login")} className="mb-2">
        <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
      </Button>

      <h1 className="mb-4 text-2xl font-bold">
        <Shield className="mr-2 inline h-6 w-6 text-primary" />
        Painel Admin
      </h1>

      {/* Pending Requests */}
      <h2 className="mb-2 text-lg font-semibold">Solicitações Pendentes</h2>
      {pendingRequests.length === 0 ? (
        <p className="mb-6 text-sm text-muted-foreground">Nenhuma solicitação pendente</p>
      ) : (
        <div className="mb-6 space-y-3">
          {pendingRequests.map((req) => (
            <Card key={req.id}>
              <CardContent className="p-4">
                <p className="font-semibold">{req.worker_name}</p>
                <p className="mb-3 text-xs text-muted-foreground">
                  {format(new Date(req.created_at), "dd/MM/yyyy HH:mm")}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    maxLength={3}
                    placeholder="Nº rota"
                    value={routeInputs[req.id] || ""}
                    onChange={(e) => setRouteInputs({ ...routeInputs, [req.id]: e.target.value.replace(/\D/g, "").slice(0, 3) })}
                    className="w-20 text-center"
                  />
                  <Button size="sm" onClick={() => handleApprove(req)} className="flex-1">
                    <Check className="mr-1 h-3 w-3" /> Aprovar
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => handleReject(req.id)}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Active Routes */}
      <h2 className="mb-2 text-lg font-semibold">Rotas Ativas</h2>
      {routes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma rota cadastrada</p>
      ) : (
        <div className="space-y-2">
          {routes.map((rt) => (
            <Card key={rt.id}>
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <span className="mr-2 font-mono text-lg font-bold text-primary">{rt.route_number}</span>
                  <span className="text-sm">{rt.worker_name}</span>
                </div>
                <Badge variant={rt.status === "active" ? "default" : "secondary"}>
                  {rt.status === "active" ? "Ativa" : "Inativa"}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Processed Requests */}
      {processedRequests.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-lg font-semibold">Histórico de Solicitações</h2>
          <div className="space-y-2">
            {processedRequests.map((req) => (
              <Card key={req.id} className="opacity-60">
                <CardContent className="flex items-center justify-between p-3">
                  <div>
                    <p className="text-sm font-medium">{req.worker_name}</p>
                    {req.assigned_route_number && (
                      <p className="text-xs text-muted-foreground">Rota: {req.assigned_route_number}</p>
                    )}
                  </div>
                  <Badge variant={req.status === "approved" ? "default" : "destructive"}>
                    {req.status === "approved" ? "Aprovado" : "Rejeitado"}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
