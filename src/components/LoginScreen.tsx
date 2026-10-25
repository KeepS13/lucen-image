import { LockKeyhole, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { legacyPath, loginPath } from "../lib/basePath";
import { login } from "../lib/session";

interface LoginScreenProps {
  onAuthenticated: () => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      await login(password);
      const returnTo = new URLSearchParams(window.location.search).get("returnTo");
      const legacy = legacyPath();
      const returnPath = returnTo?.split(/[?#]/, 1)[0];
      if (returnTo && [legacy, legacy + "/", legacy + "/index.html"].includes(returnPath || "")) {
        window.location.assign(returnTo);
        return;
      }
      window.history.replaceState(null, "", loginPath());
      onAuthenticated();
    } catch (cause) {
      const authError = cause as Error & { code?: string; retryAfter?: number };
      setError(
        authError.code === "AUTH_RATE_LIMITED"
          ? "尝试次数过多，请稍后再试"
          : authError.code === "AUTH_INVALID"
            ? "访问密码不正确"
            : authError.message || "登录失败",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative z-10 grid min-h-screen place-items-center p-5">
      <section className="glass-strong w-full max-w-[380px] rounded-2xl p-6 sm:p-7" aria-labelledby="login-title">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-[var(--line-strong)] bg-[var(--panel-solid)] text-[var(--accent)]">
            <LockKeyhole size={21} />
          </div>
          <div className="min-w-0">
            <h1 id="login-title" className="font-display m-0 text-[20px] font-bold text-[var(--ink)]">
              LUCEN 光相
            </h1>
            <p className="m-0 mt-0.5 text-[12px] text-[var(--muted)]">请输入工作台访问密码</p>
          </div>
        </div>

        <form className="grid gap-4" onSubmit={submit}>
          <label className="field-label">
            访问密码
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(error)}
            />
          </label>
          {error && (
            <p className="m-0 rounded-lg border border-[var(--err)]/30 bg-[var(--err)]/10 px-3 py-2 text-[12px] text-[var(--err)]" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary w-full" type="submit" disabled={busy || !password}>
            <LogIn size={16} /> {busy ? "正在登录…" : "进入工作台"}
          </button>
        </form>
      </section>
    </main>
  );
}
