function isBrowser() {
  return typeof window !== "undefined";
}

function resolvePublicEnvValue(primaryKey: string, fallbackKey?: string): string | undefined {
  if (isBrowser()) {
    return process.env[primaryKey];
  }

  return process.env[primaryKey] ?? (fallbackKey ? process.env[fallbackKey] : undefined);
}

export function getPublicSupabaseEnv() {
  const values = {
    url: resolvePublicEnvValue("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"),
    anonKey: resolvePublicEnvValue("NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY")
  };

  if (!values.url) {
    throw new Error(
      isBrowser()
        ? "Missing Supabase URL in browser bundle. Set NEXT_PUBLIC_SUPABASE_URL."
        : "Missing Supabase URL. Set NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL."
    );
  }

  if (!values.anonKey) {
    throw new Error(
      isBrowser()
        ? "Missing Supabase publishable key in browser bundle. Set NEXT_PUBLIC_SUPABASE_ANON_KEY."
        : "Missing Supabase publishable key. Set NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY."
    );
  }

  return values as { url: string; anonKey: string };
}

export function getServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!key) {
    throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
  }

  return key;
}
