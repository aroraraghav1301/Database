export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, "content-type": "application/json" } });

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Verifies the per-database secret key, then returns the admin client and row. */
export async function authorize(request: Request, id: string) {
  const key = request.headers.get("x-api-key") ?? new URL(request.url).searchParams.get("key") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !key) return { error: json({ error: "Missing database id or key" }, 401) } as const;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin.from("databases").select("id, name, data, api_key").eq("id", id).maybeSingle();
  if (!row || !safeEqual(row.api_key, key)) return { error: json({ error: "Invalid database id or key" }, 401) } as const;
  return { admin: supabaseAdmin, row } as const;
}
