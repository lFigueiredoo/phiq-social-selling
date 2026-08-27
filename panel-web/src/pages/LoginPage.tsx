import { LockKeyhole, ShieldCheck } from "lucide-react";
import { Navigate } from "react-router";
import { LoginForm } from "@/components/auth/LoginForm";
import { useAuth } from "@/context/AuthProvider";

export function LoginPage() {
  const { session, isLoading } = useAuth();

  if (!isLoading && session) return <Navigate to="/" replace />;

  return (
    <div className="grid min-h-screen place-items-center p-4 sm:p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-md">
            <ShieldCheck className="size-5.5" />
          </div>
          <p className="panel-eyebrow">PHIQ · Social Selling</p>
          <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">Painel de aprovação</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Entre para revisar respostas sugeridas antes que elas sigam para a etapa de envio.
          </p>
        </div>

        <div className="panel-surface rounded-2xl p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-2 text-sm font-medium">
            <div className="flex size-8 items-center justify-center rounded-lg bg-secondary text-primary">
              <LockKeyhole className="size-4" />
            </div>
            Acesso do revisor
          </div>
          <LoginForm />
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          A aprovação não dispara mensagens diretamente. O dispatcher permanece separado.
        </p>
      </div>
    </div>
  );
}
