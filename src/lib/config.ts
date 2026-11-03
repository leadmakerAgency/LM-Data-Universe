// Public Supabase connection settings.
//
// NEXT_PUBLIC_* variables are inlined into the browser bundle at build time,
// so a deploy built without them would crash on the first Supabase call.
// These values are public by design (the publishable key only grants what the
// database's row-level security allows), so the project's own values are kept
// here as a fallback. Set the env vars to point a deployment elsewhere.
const FALLBACK_URL = "https://bcvcfqyymwypwclsdeog.supabase.co";
const FALLBACK_KEY = "sb_publishable_xE9s0tuqRKFiaZtJktp4KA_NWWPsWFN";

// Referenced literally so Next.js can inline them.
export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || FALLBACK_URL).trim();
export const SUPABASE_KEY = (
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  FALLBACK_KEY
).trim();
