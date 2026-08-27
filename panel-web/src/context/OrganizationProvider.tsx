import { createContext, useContext, useState, type ReactNode } from "react";

const STORAGE_KEY = "panel-web:selected-organization-id";

interface OrganizationContextValue {
  organizationId: string | null;
  selectOrganization: (organizationId: string) => void;
  clearOrganization: () => void;
}

const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined);

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const [organizationId, setOrganizationId] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );

  function selectOrganization(id: string) {
    localStorage.setItem(STORAGE_KEY, id);
    setOrganizationId(id);
  }

  function clearOrganization() {
    localStorage.removeItem(STORAGE_KEY);
    setOrganizationId(null);
  }

  return (
    <OrganizationContext.Provider
      value={{ organizationId, selectOrganization, clearOrganization }}
    >
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization(): OrganizationContextValue {
  const ctx = useContext(OrganizationContext);
  if (!ctx) throw new Error("useOrganization must be used within OrganizationProvider");
  return ctx;
}
