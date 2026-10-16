import { createFileRoute } from "@tanstack/react-router";
import { CORS, authorize, json } from "@/lib/api-auth.server";

const BUCKET = "brace-files";

export const Route = createFileRoute("/api/public/db/$id/files")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request, params }) => {
        const a = await authorize(request, params.id);
        if ("error" in a) return a.error;
        const { data } = await a.admin.storage.from(BUCKET).list(params.id, { limit: 1000 });
        const files = await Promise.all((data ?? []).map(async (f) => {
          const { data: s } = await a.admin.storage.from(BUCKET).createSignedUrl(`${params.id}/${f.name}`, 3600);
          return { name: f.name, size: f.metadata?.size ?? null, url: s?.signedUrl ?? null };
        }));
        return json({ files });
      },
      // multipart/form-data with field "file"
      POST: async ({ request, params }) => {
        const a = await authorize(request, params.id);
        if ("error" in a) return a.error;
        const form = await request.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) return json({ error: 'Send multipart form-data with a "file" field' }, 400);
        const name = file.name.replace(/[^\w.\-]/g, "_").slice(0, 150);
        const { error } = await a.admin.storage.from(BUCKET).upload(`${params.id}/${name}`, file, { upsert: true, contentType: file.type || "application/octet-stream" });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, name });
      },
    },
  },
});
