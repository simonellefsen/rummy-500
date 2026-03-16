function isBrowser() {
  return typeof window !== "undefined";
}

export function getPublicSupabaseEnv() {
  const values = {
    url: isBrowser()
      ? process.env.NEXT_PUBLIC_SUPABASE_URL
      : process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
    anonKey: isBrowser()
      ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY
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

export function getPublicGoogleClientId(): string | undefined {
  return process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
}
