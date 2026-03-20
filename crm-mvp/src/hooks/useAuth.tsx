"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";

interface UserInfo {
  userId: string;
  username: string;
  role: "admin" | "user";
}

interface AuthContextType {
  user: UserInfo | null;
  loading: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  logout: async () => {},
  refresh: async () => {},
});

export function AuthProvider({
  children,
  requiredRole,
}: {
  children: ReactNode;
  requiredRole: "admin" | "user";
}) {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const loginPath = requiredRole === "admin" ? "/admin/login" : "/user/login";

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me").then((r) => r.json());
      if (res.code === 0 && res.data?.role === requiredRole) {
        setUser(res.data);
      } else {
        router.replace(loginPath);
      }
    } catch {
      router.replace(loginPath);
    } finally {
      setLoading(false);
    }
  }, [requiredRole, router, loginPath]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    router.replace(loginPath);
  }, [router, loginPath]);

  const refresh = useCallback(async () => {
    await fetchUser();
  }, [fetchUser]);

  return (
    <AuthContext.Provider value={{ user, loading, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
