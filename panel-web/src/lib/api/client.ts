import { SUPABASE_FUNCTIONS_URL, supabase } from "@/lib/supabase";

// The panel-* Edge Functions' CORS allow-list only permits the
// "authorization" and "content-type" request headers (see
// supabase/functions/_shared/cors.ts). supabase-js's functions.invoke()
// attaches an "apikey" header by default, which fails CORS preflight from
// a browser. So we call these functions with plain fetch() instead,
// sending only the headers the server actually allows.
export class PanelApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "PanelApiError";
    this.status = status;
    this.code = code;
  }
}

async function authHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new PanelApiError(401, "unauthorized");
  }
  return `Bearer ${token}`;
}

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

interface OkEnvelope {
  ok: boolean;
  error?: string;
}

export async function callPanelFunction<T>(
  functionName: string,
  { method = "GET", query, body }: RequestOptions = {},
): Promise<T> {
  const url = new URL(`${SUPABASE_FUNCTIONS_URL}/${functionName}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    Authorization: await authHeader(),
  };
  if (method === "POST") headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new PanelApiError(0, "network_error");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PanelApiError(response.status, "invalid_response");
  }

  if (typeof payload !== "object" || payload === null || !("ok" in payload)) {
    throw new PanelApiError(response.status, "invalid_response");
  }

  const envelope = payload as OkEnvelope;
  if (!envelope.ok) {
    throw new PanelApiError(response.status, envelope.error ?? "unknown_error");
  }

  return payload as T;
}
