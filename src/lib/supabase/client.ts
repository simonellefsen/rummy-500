import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getPublicSupabaseEnv } from "./env";

let browserClient: SupabaseClient | undefined;

export function createBrowserSupabaseClient() {
  if (!browserClient) {
    const { anonKey, url } = getPublicSupabaseEnv();

    browserClient = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true
      }
    });
  }

  return browserClient;
}
