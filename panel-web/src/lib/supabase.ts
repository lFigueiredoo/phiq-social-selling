import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env and fill in your local Supabase values.",
  );
}

// Used exclusively for Supabase Auth (sign in/out, session management).
// Business data always goes through the panel-* Edge Functions in lib/api,
// never through this client's .from()/.rpc() — those calls would be
// rejected server-side anyway (no RLS policies grant anon/authenticated
// access to any business table).
export const supabase = createClient(supabaseUrl, supabasePublishableKey);

export const SUPABASE_FUNCTIONS_URL = `${supabaseUrl}/functions/v1`;
