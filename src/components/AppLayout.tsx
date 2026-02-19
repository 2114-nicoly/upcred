import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CalendarDays, Users, CalendarCheck, Landmark, Menu, LogOut } from "lucide-react";
import { useRoute } from "@/contexts/RouteContext";
import { supabase } from "@/integrations/supabase/client";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/loan-utils";

const navItems = [
  { path: "/", label: "Hoje", icon: CalendarDays },
  { path: "/active-loans", label: "Ativos", icon: Landmark },
  { path: "/payment-history", label: "Histórico", icon: CalendarCheck },
];

type ClientWithLoan = {
  id: string;
  name: string;
  client_code: number | null;
  activeLoans: number;
  totalOwed: number;
};

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { route, logout } = useRoute();
  const [clients, setClients] = useState<ClientWithLoan[]>([]);
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (!route) return;
    const fetchClients = async () => {
      const { data: clientsData } = await supabase
        .from("clients")
        .select("id, name, client_code")
        .eq("route_id", route.id)
        .order("client_code", { ascending: true });

      if (!clientsData) return;

      const { data: loans } = await supabase
        .from("loans")
        .select("id, client_id, total_amount, status")
        .eq("route_id", route.id)
        .neq("status", "paid");

      const clientList: ClientWithLoan[] = clientsData.map((c: any) => {
        const activeLoans = (loans || []).filter((l: any) => l.client_id === c.id);
        return {
          id: c.id,
          name: c.name,
          client_code: c.client_code,
          activeLoans: activeLoans.length,
          totalOwed: activeLoans.reduce((s: number, l: any) => s + Number(l.total_amount), 0),
        };
      });
      setClients(clientList);
    };
    fetchClients();
  }, [route, location.pathname]);

  const filtered = clients.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    String(c.client_code || "").includes(search)
  );

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b bg-card px-4 py-2">
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <SheetHeader className="border-b p-4">
              <SheetTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" /> Clientes
              </SheetTitle>
            </SheetHeader>
            <div className="p-3">
              <Input
                placeholder="Buscar cliente..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="mb-3"
              />
              <div className="max-h-[calc(100vh-200px)] space-y-1 overflow-y-auto">
                {filtered.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { navigate(`/clients/${c.id}`); setSidebarOpen(false); }}
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <div>
                      <span className="font-medium">{c.client_code ? `#${c.client_code} - ` : ""}{c.name}</span>
                      {c.activeLoans > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {c.activeLoans} empréstimo{c.activeLoans > 1 ? "s" : ""} • {formatCurrency(c.totalOwed)}
                        </p>
                      )}
                    </div>
                    {c.activeLoans > 0 && (
                      <Badge variant="default" className="ml-2 text-xs">{c.activeLoans}</Badge>
                    )}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">Nenhum cliente</p>
                )}
              </div>
            </div>
            <div className="absolute bottom-0 left-0 right-0 border-t p-3">
              <Button variant="ghost" size="sm" className="w-full justify-start text-destructive" onClick={handleLogout}>
                <LogOut className="mr-2 h-4 w-4" /> Sair da Rota
              </Button>
            </div>
          </SheetContent>
        </Sheet>

        <span className="text-sm font-medium">
          Rota <span className="font-mono font-bold text-primary">{route?.route_number}</span>
        </span>

        <Link to="/clients">
          <Button variant="ghost" size="icon">
            <Users className="h-5 w-5" />
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-auto pb-20">{children}</main>

      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-card shadow-lg">
        <div className="mx-auto flex max-w-lg items-center justify-around">
          {navItems.map((item) => {
            const active = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex flex-1 flex-col items-center gap-1 py-3 text-xs font-medium transition-colors ${
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <item.icon className={`h-5 w-5 ${active ? "text-primary" : ""}`} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
