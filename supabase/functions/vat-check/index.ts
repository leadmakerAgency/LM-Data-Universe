// vat-check: checks an EU VAT number with the European Commission's VIES
// service and returns the registered name and address. Signed-in users only
// (deployed with JWT verification on). Used by the invoice editor's "Check".
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MESSAGES: Record<string, string> = {
  INVALID_INPUT: "That doesn't look like an EU VAT number",
  MS_UNAVAILABLE: "The country's VAT service is unavailable right now; try again later",
  MS_MAX_CONCURRENT_REQ: "The VAT service is busy; try again in a minute",
  SERVICE_UNAVAILABLE: "The EU VAT service (VIES) is unavailable right now",
  TIMEOUT: "The VAT service didn't answer in time",
  GLOBAL_MAX_CONCURRENT_REQ: "The VAT service is busy; try again in a minute",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let vat = "";
  try {
    vat = String(((await req.json()) as { vat?: unknown }).vat ?? "");
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const clean = vat.toUpperCase().replace(/[\s.\-]/g, "");
  const m = /^([A-Z]{2})([0-9A-Z+*]{2,13})$/.exec(clean);
  if (!m) return json({ valid: false, error: MESSAGES.INVALID_INPUT });
  // VIES uses EL for Greece and XI for Northern Ireland.
  const country = m[1] === "GR" ? "EL" : m[1];
  try {
    const res = await fetch("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ countryCode: country, vatNumber: m[2] }),
      signal: AbortSignal.timeout(12_000),
    });
    const r = (await res.json().catch(() => ({}))) as { valid?: boolean; name?: string; address?: string; userError?: string; actionSucceed?: boolean; errorWrappers?: { error?: string }[] };
    const code = r.userError && r.userError !== "VALID" && r.userError !== "INVALID" ? r.userError : r.errorWrappers?.[0]?.error;
    if (code) return json({ valid: false, error: MESSAGES[code] ?? `VIES: ${code}` });
    const tidy = (s?: string) => (s && s !== "---" ? s.replace(/\s*\n\s*/g, "\n").trim() : "");
    return json({ valid: !!r.valid, name: tidy(r.name), address: tidy(r.address), country: m[1] === "EL" ? "GR" : m[1] === "XI" ? "GB" : m[1] });
  } catch (e) {
    return json({ valid: false, error: `The EU VAT service couldn't be reached (${e instanceof Error ? e.message : String(e)})` });
  }
});
