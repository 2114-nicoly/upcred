import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type WorkerOption = {
  id: string;
  nome: string;
  login_codigo: string;
  active: boolean;
};

type Ctx = {
  selectedWorkerId: string | null; // null = todos (consolidado)
  setSelectedWorkerId: (id: string | null) => void;
  workers: WorkerOption[];
  loading: boolean;
  selectedWorkerName: string | null;
  refresh: () => Promise<void>;
};

const STORAGE_KEY = "admin_worker_filter";

const WorkerFilterContext = createContext<Ctx>({
  selectedWorkerId: null,
  setSelectedWorkerId: () => {},
  workers: [],
  loading: false,
  selectedWorkerName: null,
  refresh: async () => {},
});

export function WorkerFilterProvider({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedWorkerId, setSelectedWorkerIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(STORAGE_KEY) || null;
  });

  const setSelectedWorkerId = useCallback((id: string | null) => {
    setSelectedWorkerIdState(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const refresh = useCallback(async () => {
    if (!isAdmin) {
      setWorkers([]);
      return;
    }
    setLoading(true);
    const { data } = await supabase.rpc("admin_list_workers" as any);
    setWorkers((data as WorkerOption[]) || []);
    setLoading(false);
  }, [isAdmin]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectedWorkerName = selectedWorkerId
    ? workers.find((w) => w.id === selectedWorkerId)?.nome ?? null
    : null;

  return (
    <WorkerFilterContext.Provider
      value={{ selectedWorkerId, setSelectedWorkerId, workers, loading, selectedWorkerName, refresh }}
    >
      {children}
    </WorkerFilterContext.Provider>
  );
}

export function useWorkerFilter() {
  return useContext(WorkerFilterContext);
}
