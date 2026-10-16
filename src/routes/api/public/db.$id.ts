import { createFileRoute } from "@tanstack/react-router";
import { CORS, authorize, json } from "@/lib/api-auth.server";
import { execute, splitStatements, type DB } from "@/lib/braceql";

export const Route = createFileRoute("/api/public/db/$id")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request, params }) => {
        const a = await authorize(request, params.id);
        if ("error" in a) return a.error;
        return json({ name: a.row.name, ...(a.row.data as object) });
      },
      // Body: { "query": "INSERT INTO {...}" }  or  { "data": { "tables": {...} } }
      POST: async ({ request, params }) => {
        const a = await authorize(request, params.id);
        if ("error" in a) return a.error;
        let body: { query?: string; data?: { tables?: unknown; name?: string } };
        try { body = await request.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
        const db: DB = { name: a.row.name, tables: ((a.row.data as { tables?: DB["tables"] }).tables ?? {}) };
        let results: unknown[] = [];
        if (typeof body.query === "string") {
          if (body.query.length > 100_000) return json({ error: "Query too long" }, 400);
          results = splitStatements(body.query).map((stmt) => ({ stmt, ...execute(db, stmt) }));
        } else if (body.data && typeof body.data.tables === "object") {
          db.tables = body.data.tables as DB["tables"];
          if (typeof body.data.name === "string") db.name = body.data.name.slice(0, 100);
        } else return json({ error: 'Send { "query": "..." } or { "data": { "tables": {} } }' }, 400);
        const { error } = await a.admin.from("databases")
          .update({ name: db.name, data: { ...(a.row.data as object), tables: db.tables }, updated_at: new Date().toISOString() })
          .eq("id", params.id);
        if (error) return json({ error: "Save failed" }, 500);
        return json({ ok: true, results, database: db });
      },
    },
  },
});
