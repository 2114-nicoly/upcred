import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useRoute } from "@/contexts/RouteContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Landmark, ArrowRight } from "lucide-react";
import { toast } from "sonner";

export default function LoginPage() {
  const [routeNumber, setRouteNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useRoute();
  const navigate = useNavigate();

  const handleLogin = async () => {
    if (!routeNumber.trim()) {
      toast.error("Informe o número da rota");
      return;
    }
    setLoading(true);
    const success = await login(routeNumber.trim());
    setLoading(false);
    if (success) {
      toast.success("Bem-vindo!");
      navigate("/");
    } else {
      toast.error("Número de rota inválido ou inativo");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <Landmark className="mx-auto mb-2 h-12 w-12 text-primary" />
          <CardTitle className="text-2xl">Entrar no Sistema</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Número da Rota</Label>
            <Input
              type="text"
              maxLength={3}
              placeholder="000"
              value={routeNumber}
              onChange={(e) => setRouteNumber(e.target.value.replace(/\D/g, "").slice(0, 3))}
              className="text-center text-2xl tracking-widest"
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            />
          </div>
          <Button onClick={handleLogin} disabled={loading} className="w-full" size="lg">
            {loading ? "Entrando..." : "Entrar"}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
          <div className="text-center">
            <Button variant="link" onClick={() => navigate("/route-request")} className="text-sm">
              Não tem uma rota? Solicitar permissão
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
