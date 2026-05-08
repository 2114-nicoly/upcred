import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type AuthContextType = {
  session: Session | null;
  user: User | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  workerId: string | null;
  adminId: string | null;
  loading: boolean;
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

  const clearUserContext = () => {
    setIsAdmin(false);
    setIsSuperAdmin(false);
    setWorkerId(null);
    setAdminId(null);
  };

  const loadUserContext = (uid: string) => {
    setLoading(true);
    setTimeout(async () => {
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
        setAdminId(
          ((adminData as any)?.id as string) ??
            ((workerData as any)?.parent_admin_id as string) ??
            null
        );
      } finally {
        setLoading(false);
      }
    }, 0);
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      if (newSession?.user) {
        loadUserContext(newSession.user.id);
      } else {
        clearUserContext();
        setLoading(false);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        loadUserContext(session.user.id);
      } else {
        clearUserContext();
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    localStorage.removeItem("authenticated");
  };

  return (
    <AuthContext.Provider value={{ session, user, isAdmin, isSuperAdmin, workerId, adminId, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
