export type Row = Record<string, string | number | boolean | null>;
export type Table = { columns: string[]; rows: Row[] };
export type DB = { name: string; tables: Record<string, Table> };
export type Result = { ok: boolean; message: string; rows?: Row[]; columns?: string[] };

function parseValue(v: string): string | number | boolean | null {
  const t = v.trim().replace(/^["']|["']$/g, "");
  if (t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !isNaN(Number(t))) return Number(t);
  return t;
}

type Body = { name?: string; table?: string; columns?: string; values?: string; where?: string; set?: string; limit?: string };
function parseBody(body: string): Body {
  const out: Record<string, string> = {};
  const ret = out as Body;
  body
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((part) => {
      const i = part.indexOf(":");
      if (i === -1) throw new Error(`Expected "key: value" but got "${part}"`);
      out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    });
  return ret;
}

function pairs(s: string | undefined): Row {
  const r: Row = {};
  if (!s) return r;
  s.split(",").forEach((p) => {
    const i = p.indexOf("=");
    if (i === -1) throw new Error(`Expected "col=value" but got "${p.trim()}"`);
    r[p.slice(0, i).trim()] = parseValue(p.slice(i + 1));
  });
  return r;
}

const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => row[k] === v);

function getTable(db: DB, name?: string): Table {
  if (!name) throw new Error("Missing table name");
  const t = db.tables[name];
  if (!t) throw new Error(`Table "${name}" does not exist`);
  return t;
}

export function splitStatements(src: string): string[] {
  const out: string[] = [];
  const re = /([A-Za-z ]+?)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push(m[0]);
  return out;
}

export function execute(db: DB, stmt: string): Result {
  try {
    const m = stmt.trim().match(/^([A-Za-z ]+?)\s*\{([^}]*)\}$/);
    if (!m) throw new Error("Syntax: COMMAND {key: value;}");
    const cmd = (m[1] ?? "").trim().toUpperCase().replace(/\s+/g, " ");
    const b = parseBody(m[2] ?? "");
    switch (cmd) {
      case "CREATE TABLE": {
        if (!b.name) throw new Error("Missing name");
        if (db.tables[b.name]) throw new Error(`Table "${b.name}" already exists`);
        const columns = b.columns ? b.columns.split(",").map((c) => c.trim()).filter(Boolean) : [];
        db.tables[b.name] = { columns, rows: [] };
        return { ok: true, message: `Table "${b.name}" created` };
      }
      case "DROP TABLE": {
        getTable(db, b.name);
        delete db.tables[b.name as string];
        return { ok: true, message: `Table "${b.name}" dropped` };
      }
      case "INSERT INTO": {
        const t = getTable(db, b.table);
        const row = pairs(b.values);
        Object.keys(row).forEach((k) => !t.columns.includes(k) && t.columns.push(k));
        t.rows.push(row);
        return { ok: true, message: `1 row inserted into "${b.table}"` };
      }
      case "SELECT": {
        const t = getTable(db, b.table);
        const where = pairs(b.where);
        let rows = t.rows.filter((r) => matches(r, where));
        if (b.limit) rows = rows.slice(0, Number(b.limit));
        const columns = b.columns ? b.columns.split(",").map((c) => c.trim()) : t.columns;
        return { ok: true, message: `${rows.length} row(s)`, rows, columns };
      }
      case "UPDATE": {
        const t = getTable(db, b.table);
        const set = pairs(b.set);
        const where = pairs(b.where);
        let n = 0;
        t.rows.forEach((r) => {
          if (matches(r, where)) {
            Object.assign(r, set);
            n++;
          }
        });
        Object.keys(set).forEach((k) => !t.columns.includes(k) && t.columns.push(k));
        return { ok: true, message: `${n} row(s) updated` };
      }
      case "DELETE FROM": {
        const t = getTable(db, b.table);
        const where = pairs(b.where);
        const before = t.rows.length;
        t.rows = t.rows.filter((r) => !matches(r, where));
        return { ok: true, message: `${before - t.rows.length} row(s) deleted` };
      }
      case "SHOW TABLES": {
        const rows = Object.entries(db.tables).map(([name, t]) => ({ name, rows: t.rows.length, columns: t.columns.join(", ") }));
        return { ok: true, message: `${rows.length} table(s)`, rows, columns: ["name", "rows", "columns"] };
      }
      default:
        throw new Error(`Unknown command "${cmd}"`);
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// Turn a database JSON back into the BraceQL that would rebuild it.
// Note: BraceQL has no escaping, so values containing , ; { } can't round-trip.
export function toBraceQL(db: DB): string {
  const fmt = (v: Row[string] | undefined) => (v === null || v === undefined ? "null" : String(v));
  const out: string[] = [];
  for (const [name, t] of Object.entries(db.tables)) {
    const cols = t.columns.length ? t.columns : Array.from(new Set(t.rows.flatMap((r) => Object.keys(r))));
    out.push(`CREATE TABLE {name: ${name}; columns: ${cols.join(", ")};}`);
    for (const r of t.rows) {
      const vals = cols.filter((c) => c in r).map((c) => `${c}=${fmt(r[c])}`).join(", ");
      out.push(`INSERT INTO {table: ${name}; values: ${vals};}`);
    }
  }
  return out.join("\n");
}

// Validate + normalise database JSON (used by Import and Edit JSON).
export function parseDb(text: string, fallbackName: string): DB {
  const d = JSON.parse(text);
  if (!d || typeof d.tables !== "object" || d.tables === null || Array.isArray(d.tables)) {
    throw new Error('JSON must contain a "tables" object');
  }
  const tables: DB["tables"] = {};
  for (const [name, t] of Object.entries(d.tables as Record<string, { columns?: unknown; rows?: unknown }>)) {
    if (!t || !Array.isArray(t.rows)) throw new Error(`Table "${name}" needs a "rows" array`);
    const rows = t.rows as Row[];
    const columns = Array.isArray(t.columns) ? (t.columns as string[]) : Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    tables[name] = { columns, rows };
  }
  return { name: typeof d.name === "string" && d.name ? d.name : fallbackName, tables };
}
