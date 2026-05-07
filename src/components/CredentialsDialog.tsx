import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { Copy } from "lucide-react";

export type GeneratedCreds = {
  nome: string;
  role: string;
  login: string;
  password: string;
  created_at?: string;
};

export function CredentialsDialog({
  creds,
  onClose,
}: {
  creds: GeneratedCreds | null;
  onClose: () => void;
}) {
  function copy() {
    if (!creds) return;
    const text = `Nome: ${creds.nome}\nRole: ${creds.role}\nLogin: ${creds.login}\nSenha: ${creds.password}`;
    navigator.clipboard.writeText(text);
    toast({ title: "Copiado para a área de transferência" });
  }
  return (
    <Dialog open={!!creds} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Credenciais geradas</DialogTitle>
          <DialogDescription>
            Guarde essas informações. A senha temporária deve ser enviada ao usuário com cuidado.
          </DialogDescription>
        </DialogHeader>
        {creds && (
          <div className="space-y-2 text-sm">
            <Row label="Nome" value={creds.nome} />
            <Row label="Role" value={creds.role} />
            <Row label="Login" value={creds.login} />
            <Row label="Senha temporária" value={creds.password} highlight />
            {creds.created_at && (
              <Row label="Criado em" value={new Date(creds.created_at).toLocaleString()} />
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={copy}>
            <Copy className="h-4 w-4 mr-1" /> Copiar tudo
          </Button>
          <Button onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded border p-2">
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground">{label}</p>
        <p className={`font-mono text-sm truncate ${highlight ? "text-primary font-bold" : ""}`}>{value}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => {
          navigator.clipboard.writeText(value);
          toast({ title: "Copiado" });
        }}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  );
}
