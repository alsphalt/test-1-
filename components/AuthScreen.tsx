"use client";

import { useState } from "react";
import { api, errorMessage, fieldErrors } from "./api";
import type { Me } from "./types";

type Mode = "login" | "signup";

export default function AuthScreen({
  onAuthed,
  initialMode = "login",
}: {
  onAuthed: (user: Me) => void;
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const strength = (() => {
    if (!password) return { label: "", cls: "" };
    const ok = password.length >= 10 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
    if (password.length < 10) return { label: "At least 10 characters", cls: "bad" };
    if (!ok) return { label: "Add a letter and a number", cls: "bad" };
    return { label: "Strong enough", cls: "good" };
  })();

  const mismatch = mode === "signup" && confirm.length > 0 && confirm !== password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (mode === "signup") {
      if (name.trim().length < 2) return setError("Enter your name (2+ characters).");
      if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
        return setError("Passwords need 10+ characters with at least one letter and one number.");
      }
      if (password !== confirm) return setError("Those passwords do not match.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError("Enter a valid email address.");

    setBusy(true);
    try {
      const path = mode === "signup" ? "/api/auth/register" : "/api/auth/login";
      const body = mode === "signup" ? { name: name.trim(), email, password } : { email, password };
      const res = await api.post<{ user: Me }>(path, body);
      onAuthed(res.user);
    } catch (err) {
      const fields = fieldErrors(err);
      const first = Object.values(fields)[0];
      setError(first || errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="dn-auth" className="show">
      <div className="auth-box">
        <div className="brandline">
          <div className="d">◈</div>
          <strong>
            DARKNOTE <em>NEXUS</em>
          </strong>
        </div>
        <p className="hint">
          {mode === "login" ? "Sign in to your command layer." : "Create your account — it is stored server-side."}
        </p>

        <div className="tabs" role="tablist" aria-label="Authentication">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={mode === "login" ? "on" : ""}
            onClick={() => {
              setMode("login");
              setError("");
            }}
          >
            Log in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signup"}
            className={mode === "signup" ? "on" : ""}
            onClick={() => {
              setMode("signup");
              setError("");
            }}
          >
            Sign up
          </button>
        </div>

        <form onSubmit={submit} noValidate>
          {mode === "signup" && (
            <div className="field">
              <label htmlFor="dn-name">Name</label>
              <div className="in">
                <input
                  id="dn-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  maxLength={60}
                  value={name}
                  placeholder="Ada Lovelace"
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  className={touched.name ? (name.trim().length >= 2 ? "good" : "bad") : ""}
                />
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="dn-email">Email</label>
            <div className="in">
              <input
                id="dn-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                value={email}
                placeholder="you@example.com"
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                className={touched.email ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "good" : "bad") : ""}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="dn-pass">Password</label>
            <div className="in">
              <input
                id="dn-pass"
                name="password"
                type={show ? "text" : "password"}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                value={password}
                placeholder={mode === "signup" ? "10+ characters, letters and numbers" : "Your password"}
                onChange={(e) => setPassword(e.target.value)}
                className={mode === "signup" && password ? (strength.cls === "good" ? "good" : "bad") : ""}
              />
              <button type="button" className="eye" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}>
                {show ? "Hide" : "Show"}
              </button>
            </div>
            {mode === "signup" && <div className={`match ${strength.cls}`}>{strength.label}</div>}
          </div>

          {mode === "signup" && (
            <div className="field">
              <label htmlFor="dn-confirm">Confirm password</label>
              <div className="in">
                <input
                  id="dn-confirm"
                  name="confirm"
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirm}
                  placeholder="Repeat password"
                  onChange={(e) => setConfirm(e.target.value)}
                  className={confirm ? (mismatch ? "bad" : "good") : ""}
                />
              </div>
              {mismatch && <div className="match bad">Passwords do not match</div>}
            </div>
          )}

          <div className="err" role="alert">
            {error}
          </div>

          <button className="btn red" type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
          </button>
        </form>

        <div className="fine">
          Secured session · <span>HTTP-only cookie</span>
        </div>
      </div>
    </div>
  );
}
