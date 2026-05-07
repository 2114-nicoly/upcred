import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft, Loader2, Users } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { toast } from "@/hooks/use-toast";

type Worker = { id: string; nome: string; login_codigo: string; active: boolean };
type Admin = { id: string; nome: string; email_real: string; active: boolean };

export default function SuperAdminDetailPage() {
  const { adminId } = useParams<{ adminId: string }>();
  const navigate = useNavigate();
  const { isSuperAdmin, loading: authLoading } = useAuth();
  const { setSelectedAdminId } = useWorkerFilter();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !isSuperAdmin) navigate("/");
  }, [authLoading, isSuperAdmin, navigate]);

  async function load() {
    if (!adminId) return;
    setLoading(true);
    const [{ data: admins }, { data: ws }] = await Promise.all([
      supabase.rpc("super_admin_list_admins" as any),
      supabase.rpc("list_workers_by_admin" as any, { p_admin_id: adminId }),
    ]);
    setAdmin(((admins as Admin[]) || []).find((a) => a.id === adminId) ?? null);
    setWorkers((ws as Worker[]) || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, [adminId]);

  async function toggleWorker(w: Worker) {
    const { error } = await supabase.rpc("set_worker_active" as any, { p_worker_id: w.id, p_active: !w.active });
    if (error) return toast({ title: "Erro", description: error.message, variant: "destructive" });
    load();
  }

  function viewAsAdmin() {
    if (!adminId) return;
    setSelectedAdminId(adminId);
    toast({ title: "Filtrando por admin", description: admin?.nome });
    navigate("/admin");
  }

  if (loading || !admin) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="p-3 max-w-3xl mx-auto pb-24">
      <Button variant="ghost" size="sm" className="mb-2" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
      </Button>

      <Card className="mb-3">
        <CardContent className="p-3 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold">{admin.nome}</h2>
            {!admin.active && <Badge variant="outline">Inativo</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{admin.email_real}</p>
          <Button size="sm" className="w-full mt-2" onClick={viewAsAdmin}>
            Ver dados como este admin
          </Button>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 mb-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Trabalhadores ({workers.length})</h3>
      </div>

      {workers.length === 0 ? (
        <Card><CardContent className="p-4 text-center text-sm text-muted-foreground">Nenhum trabalhador</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {workers.map((w) => (
            <Card key={w.id}>
              <CardContent className="p-3 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{w.nome}</p>
                  <p className="text-xs text-muted-foreground">Login {w.login_codigo}</p>
                </div>
                {!w.active && <Badge variant="outline" className="text-[10px]">Inativo</Badge>}
                <Switch checked={w.active} onCheckedChange={() => toggleWorker(w)} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
