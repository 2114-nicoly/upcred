import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

type Route = {
  id: string;
  route_number: string;
  worker_name: string;
};

type RouteContextType = {
  route: Route | null;
  loading: boolean;
  login: (routeNumber: string) => Promise<boolean>;
  logout: () => void;
};

const RouteContext = createContext<RouteContextType>({
  route: null,
  loading: true,
  login: async () => false,
  logout: () => {},
});

export function RouteProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem("route_number");
    if (saved) {
      loadRoute(saved).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const loadRoute = async (routeNumber: string) => {
    const { data } = await supabase
      .from("routes")
      .select("*")
      .eq("route_number", routeNumber)
      .eq("status", "active")
      .single();
    if (data) {
      setRoute({ id: data.id, route_number: data.route_number, worker_name: data.worker_name });
      return true;
    }
    return false;
  };

  const login = async (routeNumber: string) => {
    const success = await loadRoute(routeNumber);
    if (success) {
      localStorage.setItem("route_number", routeNumber);
    }
    return success;
  };

  const logout = () => {
    localStorage.removeItem("route_number");
    setRoute(null);
  };

  return (
    <RouteContext.Provider value={{ route, loading, login, logout }}>
      {children}
    </RouteContext.Provider>
  );
}

export const useRoute = () => useContext(RouteContext);
