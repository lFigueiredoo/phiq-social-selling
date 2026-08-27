import { Navigate } from "react-router";
import { LoginForm } from "@/components/auth/LoginForm";
import { useAuth } from "@/context/AuthProvider";

export function LoginPage() {
  const { session, isLoading } = useAuth();

  if (!isLoading && session) return <Navigate to="/" replace />;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <h1 className="font-heading text-xl font-medium">Painel de Aprovação — Social Selling</h1>
      <LoginForm />
    </div>
  );
}
