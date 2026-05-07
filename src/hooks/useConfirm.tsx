import { createContext, useCallback, useContext, useRef, useState, ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle } from "lucide-react";

export type ConfirmOptions = {
  title: string;
  /** Mostre exatamente o que será afetado: cliente, valor, parcela, etc. */
  description?: ReactNode;
  /** Lista de itens impactados (renderizada como bullets). */
  affected?: Array<string | { label: string; value?: string }>;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

type Ctx = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ctx | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<Ctx>((o) => {
    setOpts(o);
    setOpen(true);
    return new Promise<boolean>((resolve) => { resolverRef.current = resolve; });
  }, []);

  const finish = (value: boolean) => {
    setOpen(false);
    const r = resolverRef.current;
    resolverRef.current = null;
    if (r) r(value);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={open} onOpenChange={(v) => { if (!v) finish(false); }}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {opts?.destructive && <AlertTriangle className="h-4 w-4 text-destructive" />}
              {opts?.title}
            </AlertDialogTitle>
            {opts?.description && (
              <AlertDialogDescription className="text-sm whitespace-pre-line">
                {opts.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          {opts?.affected && opts.affected.length > 0 && (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-1">
              <p className="font-medium text-foreground mb-1">Será afetado:</p>
              <ul className="space-y-0.5">
                {opts.affected.map((a, i) => {
                  const item = typeof a === "string" ? { label: a } : a;
                  return (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">• {item.label}</span>
                      {item.value && <span className="font-mono text-foreground">{item.value}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => finish(false)}>{opts?.cancelText || "Cancelar"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => finish(true)}
              className={opts?.destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
            >
              {opts?.confirmText || "Confirmar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Ctx {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
