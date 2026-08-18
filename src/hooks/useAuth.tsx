import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { clearAllDraftsForUser } from "@/hooks/useFormDraft";
import { checkWorkerAccess } from "@/lib/access-control";

export const ACCESS_BLOCK_STORAGE_KEY = "access_block_reason";

type AuthContextType = {
  session: Session | null;
  user: User | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  workerId: string | null;
  adminId: string | null;
  loading: boolean;
  /** Verificação de licença individual ainda em andamento. */
  accessChecking: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  isAdmin: false,
  isSuperAdmin: false,
  workerId: null,
  adminId: null,
  loading: true,
  accessChecking: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [adminId, setAdminId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessChecking, setAccessChecking] = useState(true);
  const workerIdRef = useRef<string | null>(null);
  const userIdRef = useRef<string | null>(null);

  const clearUserContext = () => {
    setIsAdmin(false);
    setIsSuperAdmin(false);
    setWorkerId(null);
    setAdminId(null);
    workerIdRef.current = null;
  };

  const loadUserContext = async (uid: string) => {
    setLoading(true);
    try {
      const [{ data: roles }, { data: workerData }, { data: adminData }] = await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", uid),
        supabase.from("workers").select("id, parent_admin_id").eq("auth_user_id", uid).maybeSingle(),
        supabase.from("admins" as any).select("id").eq("auth_user_id", uid).maybeSingle(),
      ]);
      const roleNames = (roles ?? []).map((r: any) => r.role);
      setIsSuperAdmin(roleNames.includes("super_admin"));
      setIsAdmin(roleNames.includes("admin") || roleNames.includes("super_admin"));
      setWorkerId(workerData?.id ?? null);
      workerIdRef.current = (workerData?.id as string | undefined) ?? null;
      setAdminId(
        ((adminData as any)?.id as string) ??
          ((workerData as any)?.parent_admin_id as string) ??
          null
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      if (newSession?.user) {
        const sameUser = userIdRef.current === newSession.user.id;
        userIdRef.current = newSession.user.id;
        // TOKEN_REFRESHED e SIGNED_IN do mesmo usuário apenas atualizam a sessão,
        // sem recarregar contexto, sem loading e sem remontar a página.
        if ((event === "TOKEN_REFRESHED" || event === "SIGNED_IN") && sameUser) {
          return;
        }
        void loadUserContext(newSession.user.id).then(() => enforceAccess(newSession.user.id));
      } else {
        clearUserContext();
        userIdRef.current = null;
        setLoading(false);
        setAccessChecking(false);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        userIdRef.current = session.user.id;
        void loadUserContext(session.user.id).then(() => enforceAccess(session.user.id));
      } else {
        clearUserContext();
        userIdRef.current = null;
        setLoading(false);
        setAccessChecking(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const doSignOut = async (uid?: string | null) => {
    await supabase.auth.signOut();
    localStorage.removeItem("authenticated");
    clearAllDraftsForUser(uid ?? undefined);
    clearUserContext();
    setSession(null);
    setUser(null);
  };

  const signOut = async () => {
    await doSignOut(user?.id);
  };

  /** Verifica a licença individual; bloqueia encerrando a sessão. */
  const enforceAccess = async (uid: string, background = false) => {
    if (!background) setAccessChecking(true);
    try {
      const result = await checkWorkerAccess(uid);
      if (!result.allowed) {
        try {
          sessionStorage.setItem(ACCESS_BLOCK_STORAGE_KEY, result.reason ?? "Acesso indisponível.");
        } catch { /* ignore */ }
        await doSignOut(uid);
      }
      return result;
    } finally {
      if (!background) setAccessChecking(false);
    }
  };

  // Reverificação durante a sessão: mudanças na própria licença, na própria
  // empresa e no enforcement global. Ocorre em segundo plano, sem loading.
  useEffect(() => {
    if (!user?.id) return;

    const recheck = () => { void enforceAccess(user.id, true); };

    const channel = supabase
      .channel(`access-watch-${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "access_control_settings" }, recheck);

    // Somente a própria empresa — mudanças de outras empresas não afetam este usuário.
    if (adminId) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "company_access_controls", filter: `admin_id=eq.${adminId}` },
        recheck,
      );
    }

    if (workerId) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "worker_access_licenses", filter: `worker_id=eq.${workerId}` },
        recheck,
      );
    }

    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, workerId, adminId]);


  return (
    <AuthContext.Provider value={{ session, user, isAdmin, isSuperAdmin, workerId, adminId, loading, accessChecking, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
