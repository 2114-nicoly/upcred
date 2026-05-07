import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type WorkerOption = {
  id: string;
  nome: string;
  login_codigo: string;
  active: boolean;
  parent_admin_id?: string | null;
};

export type AdminOption = {
  id: string;
  nome: string;
  email_real: string;
  login_codigo: string | null;
  active: boolean;
};

type Ctx = {
  selectedWorkerId: string | null;
  setSelectedWorkerId: (id: string | null) => void;
  selectedAdminId: string | null; // só super_admin usa
  setSelectedAdminId: (id: string | null) => void;
  workers: WorkerOption[]; // já filtrados pelo admin selecionado (se super_admin)
  admins: AdminOption[];
  loading: boolean;
  selectedWorkerName: string | null;
  selectedAdminName: string | null;
  refresh: () => Promise<void>;
};

const STORAGE_WORKER = "scope_worker_filter";
const STORAGE_ADMIN = "scope_admin_filter";

const WorkerFilterContext = createContext<Ctx>({
  selectedWorkerId: null,
  setSelectedWorkerId: () => {},
  selectedAdminId: null,
  setSelectedAdminId: () => {},
  workers: [],
  admins: [],
  loading: false,
  selectedWorkerName: null,
  selectedAdminName: null,
  refresh: async () => {},
});

export function WorkerFilterProvider({ children }: { children: ReactNode }) {
  const { isAdmin, isSuperAdmin } = useAuth();
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [loading, setLoading] = useState(false);

  const [selectedWorkerId, setSelectedWorkerIdState] = useState<string | null>(() =>
    typeof window === "undefined" ? null : localStorage.getItem(STORAGE_WORKER) || null
  );
  const [selectedAdminId, setSelectedAdminIdState] = useState<string | null>(() =>
    typeof window === "undefined" ? null : localStorage.getItem(STORAGE_ADMIN) || null
  );

  const setSelectedWorkerId = useCallback((id: string | null) => {
    setSelectedWorkerIdState(id);
    if (id) localStorage.setItem(STORAGE_WORKER, id);
    else localStorage.removeItem(STORAGE_WORKER);
  }, []);

  const setSelectedAdminId = useCallback((id: string | null) => {
    setSelectedAdminIdState(id);
    if (id) localStorage.setItem(STORAGE_ADMIN, id);
    else localStorage.removeItem(STORAGE_ADMIN);
    // Reset worker quando muda admin
    setSelectedWorkerIdState(null);
    localStorage.removeItem(STORAGE_WORKER);
  }, []);

  const refresh = useCallback(async () => {
    if (!isAdmin) {
      setWorkers([]); setAdmins([]); return;
    }
    setLoading(true);
    if (isSuperAdmin) {
      const [{ data: ad }, { data: ws }] = await Promise.all([
        supabase.rpc("super_admin_list_admins" as any),
        supabase.rpc("list_workers_by_admin" as any, { p_admin_id: selectedAdminId }),
      ]);
      setAdmins((ad as AdminOption[]) || []);
      setWorkers((ws as WorkerOption[]) || []);
    } else {
      const { data } = await supabase.rpc("admin_list_workers" as any);
      setWorkers((data as WorkerOption[]) || []);
      setAdmins([]);
    }
    setLoading(false);
  }, [isAdmin, isSuperAdmin, selectedAdminId]);

  useEffect(() => { refresh(); }, [refresh]);

  const selectedWorkerName = selectedWorkerId
    ? workers.find((w) => w.id === selectedWorkerId)?.nome ?? null
    : null;
  const selectedAdminName = selectedAdminId
    ? admins.find((a) => a.id === selectedAdminId)?.nome ?? null
    : null;

  return (
    <WorkerFilterContext.Provider
      value={{
        selectedWorkerId, setSelectedWorkerId,
        selectedAdminId, setSelectedAdminId,
        workers, admins, loading,
        selectedWorkerName, selectedAdminName,
        refresh,
      }}
    >
      {children}
    </WorkerFilterContext.Provider>
  );
}

export function useWorkerFilter() {
  return useContext(WorkerFilterContext);
}
