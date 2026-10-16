import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — BraceDB" },
      { name: "description", content: "Sign in or create a BraceDB account to store databases and files online." },
      { property: "og:title", content: "Sign in — BraceDB" },
      { property: "og:description", content: "Store BraceDB databases and files online." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    if (mode === "up") {
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { setBusy(false); return setMsg({ ok: false, text: "Username: 3–24 letters, numbers or _" }); }
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { emailRedirectTo: window.location.origin, data: { username } },
      });
      if (error) setMsg({ ok: false, text: error.message });
      else if (!data.session) setMsg({ ok: true, text: "Check your email to confirm your account, then sign in." });
      else nav({ to: "/" });
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg({ ok: false, text: error.message });
      else nav({ to: "/" });
    }
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-mono flex items-center justify-center p-4">
      <form onSubmit={submit} className="panel w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-primary text-2xl font-bold">{"{ }"}</span>
          <h1 className="text-xl font-bold">BraceDB</h1>
        </div>
        <div className="flex gap-2 text-sm">
          <button type="button" className={mode === "in" ? "btn-primary" : "btn-ghost"} onClick={() => setMode("in")}>Sign in</button>
          <button type="button" className={mode === "up" ? "btn-primary" : "btn-ghost"} onClick={() => setMode("up")}>Sign up</button>
        </div>
        {mode === "up" && (
          <input required placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} className="field" />
        )}
        <input required type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} className="field" />
        <input required type="password" minLength={6} placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} className="field" />
        <button disabled={busy} className="btn-primary w-full">{busy ? "..." : mode === "in" ? "Sign in" : "Create account"}</button>
        {msg && <p className={`text-xs ${msg.ok ? "text-primary" : "text-destructive"}`}>{msg.text}</p>}
        <Link to="/" className="block text-center text-xs text-muted-foreground hover:text-primary">
          Continue as guest (saved in this browser only) →
        </Link>
      </form>
    </div>
  );
}
