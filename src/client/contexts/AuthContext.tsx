import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react";
import { User } from "../../types/index";
import { formulateUrl } from "../utils";

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  error: Error | null;
  logout: () => void;
  hasRole: (courseId: string, role: string) => boolean;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await fetch(formulateUrl("api/v1/profile"), {
          credentials: "include", // Includes cookies in the request
        });

        if (!response.ok) {
          if (response.status === 401) {
            // User is not authenticated
            setUser(null);
            setIsLoading(false);
            return;
          }
          throw new Error(
            `Failed to fetch user profile: ${response.statusText}`,
          );
        }

        const userData: User = await response.json();
        setUser(userData);
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error("Unknown error occurred"),
        );
      } finally {
        setIsLoading(false);
      }
    };

    fetchUser();
  }, []);

  const logout = async () => {
    try {
      const response = await fetch(formulateUrl("logout"), {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`Logout failed: ${response.statusText}`);
      }

      // Clear user data regardless of API response
      setUser(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Logout failed"));
      // Still clear user data on client side even if API call fails
      setUser(null);
    }
  };

  const hasRole = (courseId: string, role: string): boolean => {
    if (!user || !user.roles) return false;

    return user.roles.some(
      (userRole) => userRole.courseId === courseId && userRole.role === role,
    );
  };

  const value = {
    user,
    isLoading,
    error,
    logout,
    hasRole,
    isAuthenticated: !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// Custom hook to use the auth context
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
