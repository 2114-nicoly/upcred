import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Send, CheckCircle } from "lucide-react";
import { toast } from "sonner";

export default function RouteRequestPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error("Informe seu nome");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("route_requests").insert({ worker_name: name.trim() });
    setSaving(false);
    if (error) {
      toast.error("Erro ao enviar solicitação");
      return;
    }
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm text-center">
          <CardContent className="p-8">
            <CheckCircle className="mx-auto mb-4 h-16 w-16 text-success" />
            <h2 className="mb-2 text-xl font-bold">Solicitação Enviada!</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              Seu pedido foi registrado. Você receberá um número de rota em breve.
            </p>
            <Button onClick={() => navigate("/login")} className="w-full">
              Voltar ao Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Button variant="ghost" size="sm" onClick={() => navigate("/login")} className="mb-2 w-fit">
            <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
          </Button>
          <CardTitle>Solicitar Permissão de Rota</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Seu Nome Completo</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do trabalhador" />
          </div>
          <Button onClick={handleSubmit} disabled={saving} className="w-full" size="lg">
            <Send className="mr-2 h-4 w-4" />
            {saving ? "Enviando..." : "Enviar Solicitação"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
