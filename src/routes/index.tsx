import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { execute, splitStatements, toBraceQL, parseDb, type DB, type Result } from "@/lib/braceql";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BraceDB — a database with its own query language" },
      { name: "description", content: "Write BraceQL queries, store databases and files online, and connect any project by URL." },
      { property: "og:title", content: "BraceDB" },
      { property: "og:description", content: "Write BraceQL queries, store files, and connect projects by URL." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

const SAMPLE = `CREATE TABLE {name: Games; columns: title, year, genre;}
INSERT INTO {table: Games; values: title=Zelda, year=1986, genre=Adventure;}
SELECT {table: Games;}`;

const STORAGE = "bracedb";
const QUERY_KEY = "bracedb:query";
type SaveStatus = "idle" | "unsaved" | "saving" | "local" | "synced" | "error";
const BUCKET = "brace-files";
const empty = (): DB => ({ name: "my_database", tables: {} });

type CloudDb = { id: string; name: string; api_key: string; data: { tables?: DB["tables"]; query?: string } };
type FileItem = { name: string; size?: number | undefined };

function Index() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState("");
  const [cloudDbs, setCloudDbs] = useState<CloudDb[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [db, setDb] = useState<DB>(empty);
  const [query, setQuery] = useState(SAMPLE);
  const [results, setResults] = useState<{ stmt: string; res: Result }[]>([]);
  const [showJson, setShowJson] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [fileError, setFileError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [jsonErr, setJsonErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryRef = useRef(query);
  const dbRef = useRef(db);
  queryRef.current = query;
  dbRef.current = db;
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  const current = cloudDbs.find((d) => d.id === currentId) ?? null;

  // Guest mode: load from browser
  useEffect(() => {
    if (!ready || userId) return;
    const s = localStorage.getItem(STORAGE);
    if (s) try { setDb(JSON.parse(s)); } catch { /* ignore */ }
    const q = localStorage.getItem(QUERY_KEY);
    if (q !== null) setQuery(q);
  }, [ready, userId]);

  // Signed in: load profile + databases
  const loadDbs = useCallback(async () => {
    if (!userId) return;
    const [{ data: p }, { data }] = await Promise.all([
      supabase.from("profiles").select("username").eq("id", userId).maybeSingle(),
      supabase.from("databases").select("id, name, api_key, data").order("created_at"),
    ]);
    setUsername(p?.username ?? "");
    const list = (data ?? []) as CloudDb[];
    setCloudDbs(list);
    setCurrentId((cur) => (cur && list.some((d) => d.id === cur) ? cur : list[0]?.id ?? null));
  }, [userId]);
  useEffect(() => { loadDbs(); }, [loadDbs]);

  const loadFiles = useCallback(async () => {
    if (!currentId) return setFiles([]);
    const { data } = await supabase.storage.from(BUCKET).list(currentId, { limit: 1000 });
    setFiles((data ?? []).filter((f) => f.name !== ".emptyFolderPlaceholder").map((f) => ({ name: f.name, size: f.metadata?.size })));
  }, [currentId]);

  useEffect(() => {
    if (current) {
      setDb({ name: current.name, tables: current.data.tables ?? {} });
      const local = localStorage.getItem(`${QUERY_KEY}:${current.id}`);
      setQuery(current.data.query ?? local ?? SAMPLE);
      setStatus("idle");
    }
    loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // Keep a <database>.json copy in the Files tab (signed-in users)
  const jsonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncJson = async (d: DB) => {
    if (!userId || !currentId) return;
    const path = `${currentId}/${d.name.replace(/[^\w.\-]/g, "_") || "database"}.json`;
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    await supabase.storage.from(BUCKET).remove([path]);
    const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: "application/json" });
    setFileError(error ? error.message : "");
    loadFiles();
  };
  const syncJsonSoon = (d: DB) => {
    if (jsonTimer.current) clearTimeout(jsonTimer.current);
    jsonTimer.current = setTimeout(() => syncJson(d), 1000);
  };

  const save = async (d: DB) => {
    setDb(d);
    if (!userId) return localStorage.setItem(STORAGE, JSON.stringify(d));
    if (!currentId) return;
    const data = { tables: d.tables, query: queryRef.current };
    setCloudDbs((l) => l.map((x) => (x.id === currentId ? { ...x, name: d.name, data } : x)));
    const { error } = await supabase.from("databases").update({ name: d.name, data, updated_at: new Date().toISOString() }).eq("id", currentId);
    if (error) setResults([{ stmt: "save", res: { ok: false, message: error.message } }]);
    syncJsonSoon(d);
  };

  // Save the query code: always in this browser, and in the database when signed in.
  const persist = async (q: string = queryRef.current) => {
    try { localStorage.setItem(userId && currentId ? `${QUERY_KEY}:${currentId}` : QUERY_KEY, q); } catch { /* ignore */ }
    if (!userId || !currentId) return setStatus("local");
    setStatus("saving");
    const data = { tables: dbRef.current.tables, query: q };
    setCloudDbs((l) => l.map((x) => (x.id === currentId ? { ...x, data } : x)));
    const { error } = await supabase.from("databases").update({ data, updated_at: new Date().toISOString() }).eq("id", currentId);
    setStatus(error ? "error" : "synced");
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const onQueryChange = (v: string) => {
    setQuery(v);
    setStatus("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persistRef.current(v), 1500); // autosave
  };

  const saveNow = () => {
    if (timer.current) clearTimeout(timer.current);
    persistRef.current();
    syncJson(dbRef.current);
  };

  // Don't lose unsaved code when the tab is closed or hidden
  useEffect(() => {
    const flush = () => { if (timer.current) { clearTimeout(timer.current); persistRef.current(); } };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => { window.removeEventListener("beforeunload", flush); document.removeEventListener("visibilitychange", onHide); };
  }, []);

  const statusText: Record<SaveStatus, string> = {
    idle: "",
    unsaved: "Unsaved changes…",
    saving: "Saving…",
    local: "Saved in this browser",
    synced: "Saved in browser + database",
    error: "Database save failed (kept in browser)",
  };

  const createDb = async () => {
    if (!userId) return;
    const name = prompt("Database name", "my_database")?.replace(/\s+/g, "_");
    if (!name) return;
    const { data } = await supabase.from("databases").insert({ owner_id: userId, name }).select("id").single();
    await loadDbs();
    if (data) setCurrentId(data.id);
  };

  const deleteDb = async () => {
    if (!current || !confirm(`Delete "${current.name}" and its files?`)) return;
    if (files.length) await supabase.storage.from(BUCKET).remove(files.map((f) => `${current.id}/${f.name}`));
    await supabase.from("databases").delete().eq("id", current.id);
    setCurrentId(null);
    loadDbs();
  };

  const run = (q: string = query) => {
    if (userId && !currentId) return setResults([{ stmt: "", res: { ok: false, message: "Create a database first" } }]);
    const next: DB = structuredClone(db);
    const stmts = splitStatements(q);
    const out = stmts.length
      ? stmts.map((stmt) => ({ stmt, res: execute(next, stmt) }))
      : [{ stmt: q, res: { ok: false, message: "No statements found" } }];
    save(next);
    setResults(out);
    if (q === query) { if (timer.current) clearTimeout(timer.current); persistRef.current(q); }
  };

  const uploadFiles = async (list: FileList) => {
    if (!currentId) return;
    for (const f of Array.from(list)) {
      const name = f.name.replace(/[^\w.\-]/g, "_");
      const { error } = await supabase.storage.from(BUCKET).upload(`${currentId}/${name}`, f, { upsert: true });
      setFileError(error ? error.message : "");
      if (error) setResults([{ stmt: f.name, res: { ok: false, message: error.message } }]);
    }
    loadFiles();
  };

  const openFile = async (name: string) => {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(`${currentId}/${name}`, 300);
    if (data) window.open(data.signedUrl, "_blank");
  };

  const removeFile = async (name: string) => {
    await supabase.storage.from(BUCKET).remove([`${currentId}/${name}`]);
    loadFiles();
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setCloudDbs([]); setCurrentId(null); setDb(empty()); setResults([]);
  };

  const json = JSON.stringify(db, null, 2);
  const download = () => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${db.name}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const importFile = async (f: File) => {
    try {
      const nd = parseDb(await f.text(), db.name);
      await save(nd);
      onQueryChange(toBraceQL(nd)); // show the generated BraceQL in the editor
      setResults([{ stmt: f.name, res: { ok: true, message: "Imported — BraceQL generated in the editor" } }]);
    } catch (e) {
      setResults([{ stmt: f.name, res: { ok: false, message: e instanceof Error ? `Invalid database JSON: ${e.message}` : "Invalid database JSON file" } }]);
    }
  };

  const closeJson = () => { setShowJson(false); setEditing(false); setJsonErr(""); };
  const applyJson = async () => {
    try {
      const nd = parseDb(draft, db.name);
      await save(nd);
      setEditing(false); setJsonErr("");
      setResults([{ stmt: "Edit JSON", res: { ok: true, message: "JSON saved" } }]);
    } catch (e) {
      setJsonErr(e instanceof Error ? e.message : "Invalid JSON");
    }
  };
  const jsonName = `${db.name.replace(/[^\w.\-]/g, "_") || "database"}.json`;

  const apiUrl = typeof window !== "undefined" && current ? `${window.location.origin}/api/public/db/${current.id}` : "";

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      <header className="border-b border-border px-6 py-4 flex flex-wrap items-center gap-4 justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-primary text-2xl font-bold">{"{ }"}</span>
          <h1 className="text-xl font-bold tracking-tight">BraceDB</h1>
          <input
            value={db.name}
            onChange={(e) => save({ ...db, name: e.target.value.replace(/\s+/g, "_") })}
            disabled={!!userId && !currentId}
            className="bg-card border border-border rounded px-2 py-1 text-sm w-44"
            aria-label="Database name"
          />
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {userId ? (
            <>
              <span className="text-xs text-muted-foreground">@{username}</span>
              {current && <button className="btn-ghost" onClick={() => setShowConnect(true)}>Connect URL</button>}
              <button className="btn-ghost" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <Link to="/auth" className="btn-ghost">Sign in / Sign up</Link>
          )}
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Import JSON</button>
          <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          <button className="btn-primary" onClick={() => setShowJson(true)}>Get JSON file</button>
        </div>
      </header>

      {ready && !userId && (
        <div className="px-6 py-2 text-xs border-b border-border text-muted-foreground">
          Guest mode — your data is saved only in this browser. <Link to="/auth" className="text-primary">Sign in</Link> to store databases and files online and connect other projects.
        </div>
      )}

      <main className="grid lg:grid-cols-[300px_1fr] gap-6 p-6">
        <section className="space-y-4 min-w-0 order-1 lg:order-2">
          <div className="panel">
            <div className="panel-head">
              <span>query.bql</span>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{statusText[status]}</span>
                <button className="btn-ghost" onClick={saveNow}>Save</button>
                <button className="btn-primary" onClick={() => run()}>Run ▶</button>
              </div>
            </div>
            <textarea
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
              }}
              spellCheck={false}
              className="w-full h-56 bg-transparent p-4 text-sm outline-none resize-y text-primary"
            />
            <p className="px-4 pb-3 text-xs text-muted-foreground">Ctrl/Cmd + Enter to run · Ctrl/Cmd + S to save · autosaves while you type</p>
          </div>

          {results.map(({ stmt, res }, i) => (
            <div key={i} className="panel">
              <div className="panel-head">
                <span className="truncate text-muted-foreground">{stmt}</span>
                <span className={res.ok ? "text-primary" : "text-destructive"}>{res.message}</span>
              </div>
              {res.rows && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr>{res.columns?.map((c) => <th key={c} className="text-left px-4 py-2 border-b border-border text-muted-foreground">{c}</th>)}</tr></thead>
                    <tbody>
                      {res.rows.map((r, j) => (
                        <tr key={j} className="border-b border-border/50">
                          {res.columns?.map((c) => <td key={c} className="px-4 py-2">{String(r[c] ?? "—")}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </section>

        <aside className="space-y-4 order-2 lg:order-1">
          <div className="panel p-4">
            <h2 className="text-xs uppercase text-muted-foreground mb-2">Tables</h2>
            {Object.keys(db.tables).length === 0 && <p className="text-sm text-muted-foreground">None yet</p>}
            {Object.entries(db.tables).map(([n, t]) => (
              <button key={n} className="block w-full text-left text-sm py-1 hover:text-primary" onClick={() => run(`SELECT {table: ${n};}`)}>
                ▸ {n} <span className="text-muted-foreground">({t.rows.length})</span>
              </button>
            ))}
            {!userId && (
              <button className="text-xs text-destructive mt-2" onClick={() => { if (confirm("Clear the whole database?")) { save(empty()); setResults([]); } }}>Reset</button>
            )}
          </div>

          {userId && (
            <div className="panel p-4">
              <div className="flex justify-between items-center mb-2">
                <h2 className="text-xs uppercase text-muted-foreground">My databases</h2>
                <button className="text-xs text-primary" onClick={createDb}>+ New</button>
              </div>
              {cloudDbs.length === 0 && <p className="text-sm text-muted-foreground">None yet — create one.</p>}
              {cloudDbs.map((d) => (
                <button key={d.id} onClick={() => setCurrentId(d.id)} className={`block w-full text-left text-sm py-1 ${d.id === currentId ? "text-primary" : "hover:text-primary"}`}>
                  {d.id === currentId ? "●" : "○"} {d.name}
                </button>
              ))}
              {current && <button className="text-xs text-destructive mt-2" onClick={deleteDb}>Delete this database</button>}
            </div>
          )}

          {userId && current && (
            <div className="panel p-4">
              <div className="flex justify-between items-center mb-2">
                <h2 className="text-xs uppercase text-muted-foreground">Files</h2>
                <button className="text-xs text-primary" onClick={() => uploadRef.current?.click()}>+ Upload</button>
                <input ref={uploadRef} type="file" multiple hidden onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
              </div>
              {fileError && <p className="text-xs text-destructive mb-2 break-words">File storage error: {fileError}. Run supabase/storage-setup.sql in the Supabase SQL editor.</p>}
              {!files.some((f) => f.name === jsonName) && (
                <div className="flex justify-between items-center text-sm py-1 gap-2">
                  <button className="truncate hover:text-primary text-left" onClick={() => setShowJson(true)}>{jsonName}</button>
                  <span className="text-xs text-muted-foreground">live</span>
                </div>
              )}
              {files.map((f) => (
                <div key={f.name} className="flex justify-between items-center text-sm py-1 gap-2">
                  <button className="truncate hover:text-primary text-left" onClick={() => (f.name === jsonName ? setShowJson(true) : openFile(f.name))}>{f.name}</button>
                  <button className="text-xs text-destructive" onClick={() => removeFile(f.name)}>✕</button>
                </div>
              ))}
            </div>
          )}

          <div className="panel p-4 text-xs space-y-2 text-muted-foreground">
            <h2 className="uppercase mb-2">BraceQL syntax</h2>
            {[
              "CREATE TABLE {name: Games; columns: title, year;}",
              "INSERT INTO {table: Games; values: title=Zelda, year=1986;}",
              "SELECT {table: Games; where: year=1986; limit: 10;}",
              "UPDATE {table: Games; set: year=1987; where: title=Zelda;}",
              "DELETE FROM {table: Games; where: title=Zelda;}",
              "DROP TABLE {name: Games;}",
              "SHOW TABLES {}",
            ].map((s) => <code key={s} className="block text-foreground/80 break-words">{s}</code>)}
          </div>
        </aside>
      </main>

      {showJson && (
        <Modal onClose={closeJson} title={`${db.name}.json`}
          actions={editing
            ? <><button className="btn-ghost" onClick={() => { setEditing(false); setJsonErr(""); }}>Cancel</button><button className="btn-primary" onClick={applyJson}>Apply &amp; save</button></>
            : <><button className="btn-ghost" onClick={() => navigator.clipboard.writeText(json)}>Copy</button><button className="btn-ghost" onClick={() => { setDraft(json); setEditing(true); }}>Edit</button><button className="btn-primary" onClick={download}>Download</button></>}>
          {editing ? (
            <div className="p-4 space-y-2 overflow-auto">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className="field w-full h-80 text-xs font-mono" />
              {jsonErr && <p className="text-xs text-destructive">{jsonErr}</p>}
            </div>
          ) : (
            <pre className="overflow-auto p-4 text-xs text-primary">{json}</pre>
          )}
        </Modal>
      )}

      {showConnect && current && (
        <Modal onClose={() => setShowConnect(false)} title="Connect another project">
          <div className="overflow-auto p-4 text-xs space-y-3">
            <p className="text-muted-foreground">Any project can read and edit this database with the link and secret key. Keep the key private.</p>
            <Field label="Database URL" value={apiUrl} />
            <Field label="Secret key (send as x-api-key header)" value={current.api_key} />
            <Field label="Files URL" value={`${apiUrl}/files`} />
            <p className="text-muted-foreground">Example (JavaScript):</p>
            <pre className="bg-background border border-border rounded p-3 text-primary whitespace-pre-wrap">{`// Read
const db = await fetch("${apiUrl}", {
  headers: { "x-api-key": "YOUR_KEY" }
}).then(r => r.json());

// Run BraceQL to edit
await fetch("${apiUrl}", {
  method: "POST",
  headers: { "x-api-key": "YOUR_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ query: "INSERT INTO {table: Games; values: title=Doom;}" })
});

// Upload a file
const form = new FormData(); form.append("file", myFile);
await fetch("${apiUrl}/files", { method: "POST", headers: { "x-api-key": "YOUR_KEY" }, body: form });`}</pre>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground mb-1">{label}</div>
      <div className="flex gap-2">
        <input readOnly value={value} className="field text-xs" onFocus={(e) => e.target.select()} />
        <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(value)}>Copy</button>
      </div>
    </div>
  );
}

function Modal({ title, onClose, actions, children }: { title: string; onClose: () => void; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="panel w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <span>{title}</span>
          <div className="flex gap-2">{actions}<button className="btn-ghost" onClick={onClose}>✕</button></div>
        </div>
        {children}
      </div>
    </div>
  );
}
