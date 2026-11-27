"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, fieldErrors } from "../api";
import { ConfirmButton, Modal, Pill, SectionEmpty, ago, useCopy, useToast } from "../ui";
import type {
  Me,
  SetupAccount,
  SetupActivity,
  SetupOverview,
  SetupRequest,
  SetupState,
} from "../types";

/**
 * Darknote Setup — owner-controlled access to Setup, on top of the normal Nexus
 * session. Nothing here is decorative: every counter comes from the database and
 * every action is an authenticated API call.
 */

type Tab = "sessions" | "accounts" | "requests" | "logs" | "security";

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "ONLINE",
  PENDING: "PAIRING_REQUESTED",
  INVITED: "OFFLINE",
  SUSPENDED: "ERROR",
  REVOKED: "LOGGED_OUT",
};

export default function Setup({ me, tick }: { me: Me; tick: number }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("sessions");
  const toast = useToast();

  const load = useCallback(() => {
    api
      .get<SetupState>("/api/setup/state")
      .then((res) => {
        setState(res);
        setError("");
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(load, [load, tick]);

  /* ------------------------------ security lock ----------------------------- */

  useEffect(() => {
    if (!state?.unlocked) return;

    let hiddenAt: number | null = null;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") {
        hiddenAt = null;
        return;
      }
      hiddenAt ??= Date.now();
      if (Date.now() - hiddenAt > 45_000) {
        hiddenAt = null;
        void lock();
      }
    }, 5_000);

    const onHide = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        // Best-effort server-side lock on a real page unload; the server also
        // enforces an idle timeout, so this is not the only control.
        navigator.sendBeacon?.("/api/setup/lock");
      }
    };

    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.unlocked]);

  const lock = async () => {
    try {
      await api.post("/api/setup/lock");
    } catch {
      /* cookie is cleared server-side when possible */
    }
    setState((prev) => (prev ? { ...prev, unlocked: false, role: null, needs: prev.ownerEligible ? "owner_token" : "code" } : prev));
    toast("Setup locked", "ok");
    load();
  };

  if (error && !state) {
    return <div className="panel" style={{ color: "#ff8fa3" }}>{error}</div>;
  }

  if (!state) {
    return (
      <div className="center" style={{ minHeight: 220 }}>
        <div className="loading" />
      </div>
    );
  }

  if (!state.unlocked) {
    return <Gate state={state} me={me} onUnlocked={load} />;
  }

  return (
    <>
      <div className="page-h">
        <div>
          <h2>
            DARKNOTE <em>SETUP</em>
          </h2>
          <p>
            {state.role === "OWNER"
              ? "Owner control: every authorised Setup account, every session and every action."
              : "Your assigned Setup dashboard. Your bot sessions are unaffected by locking this area."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="pill ONLINE">
            <i />
            {state.role === "OWNER" ? "owner" : "authorised"}
          </span>
          <button className="btn" onClick={lock}>
            Lock now
          </button>
        </div>
      </div>

      {state.role === "OWNER" ? (
        <>
          <div className="seg" style={{ marginBottom: 14 }}>
            {(
              [
                ["sessions", "Sessions"],
                ["accounts", "Owner administration"],
                ["requests", "Access requests"],
                ["logs", "Activity logs"],
                ["security", "Security"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)} type="button">
                {label}
              </button>
            ))}
          </div>

          {tab === "sessions" && <Sessions tick={tick} />}
          {tab === "accounts" && <Accounts tick={tick} />}
          {tab === "requests" && <Requests tick={tick} />}
          {tab === "logs" && <Logs tick={tick} />}
          {tab === "security" && <Security />}
        </>
      ) : (
        <MyAccount account={state.account} />
      )}
    </>
  );
}

/* ----------------------------------- gate ----------------------------------- */

function Gate({ state, me, onUnlocked }: { state: SetupState; me: Me; onUnlocked: () => void }) {
  const [value, setValue] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const toast = useToast();

  const submitUnlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/api/setup/unlock", state.needs === "owner_token" ? { ownerToken: value } : { code: value });
      toast("Setup unlocked", "ok");
      onUnlocked();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitActivation = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ message: string }>("/api/setup/activate", { username, password, code });
      setNotice(res.message);
      onUnlocked();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-h">
        <div>
          <h2>
            SETUP <em>VERIFICATION</em>
          </h2>
          <p>
            Signed in as {me.email}. Setup is a separate authorisation layer — your WhatsApp bots stay
            connected whether or not this area is unlocked.
          </p>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          {state.needs === "owner_token" && (
            <form className="form" onSubmit={submitUnlock}>
              <h4>Owner setup token</h4>
              <p className="fine">
                This account ({state.ownerEmailsHint}) is an owner account. Enter the private owner token to
                unlock Owner Administration.
              </p>
              <label className="field">
                <span>Owner token</span>
                <input
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  required
                />
              </label>
              {error && <div className="err">{error}</div>}
              <button className="btn p" disabled={busy || !value}>
                {busy ? "Verifying…" : "Unlock owner control"}
              </button>
            </form>
          )}

          {state.needs === "code" && (
            <form className="form" onSubmit={submitUnlock}>
              <h4>Enter your DARKNOTE Setup code</h4>
              <p className="fine">
                Setup account <b>{state.account?.username}</b>
                {state.account?.linkedEmail ? ` · linked to ${state.account.linkedEmail}` : ""}. Your personal
                code was sent by the owner.
              </p>
              <label className="field">
                <span>Personal setup code</span>
                <input
                  inputMode="numeric"
                  value={value}
                  onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 12))}
                  placeholder="8-digit code"
                  required
                />
              </label>
              {error && <div className="err">{error}</div>}
              <button className="btn p" disabled={busy || value.length < 6}>
                {busy ? "Verifying…" : "Enter Setup"}
              </button>
            </form>
          )}

          {state.needs === "activation" && (
            <form className="form" onSubmit={submitActivation}>
              <h4>Activate your Setup access</h4>
              <p className="fine">
                Use the username, password and personal code the owner created for you. The request goes to
                the owner for approval.
              </p>
              <label className="field">
                <span>Setup username</span>
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <label className="field">
                <span>Personal setup code</span>
                <input
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 12))}
                  required
                />
              </label>
              {error && <div className="err">{error}</div>}
              <button className="btn p" disabled={busy || !username || !password || code.length < 6}>
                {busy ? "Submitting…" : "Request access"}
              </button>
            </form>
          )}

          {state.needs === "approval" && (
            <div className="form">
              <h4>Access request submitted</h4>
              <p className="fine">
                Your DARKNOTE Setup access request has been sent to the owner. This page will unlock as soon
                as it is approved — no need to submit it again.
              </p>
              <span className="pill PAIRING_REQUESTED">
                <i />
                pending owner approval
              </span>
            </div>
          )}

          {state.needs === "blocked" && (
            <div className="form">
              <h4>Setup access unavailable</h4>
              <p className="fine">
                This Setup account is <b>{state.account?.status?.toLowerCase()}</b>. Contact the owner to
                restore it.
              </p>
            </div>
          )}

          {state.needs === "unlocked" && <SectionEmpty>Setup is unlocked.</SectionEmpty>}

          {notice && <div className="ok" style={{ marginTop: 12 }}>{notice}</div>}
        </section>

        <section className="panel">
          <h4>How this works</h4>
          <div className="rows">
            <div className="row">
              <div className="grow">
                <b>1 · The owner creates your account</b>
                <small>Username, password and phone number. A personal code is issued to that number.</small>
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <b>2 · You request access once</b>
                <small>Enter the credentials and code while signed in to your Nexus account.</small>
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <b>3 · The owner approves</b>
                <small>Your Setup account is linked to this Nexus account permanently.</small>
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <b>4 · Later visits need only the code</b>
                <small>Sign in normally, open Setup, enter your personal code.</small>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

/* --------------------------------- sessions --------------------------------- */

function Sessions({ tick }: { tick: number }) {
  const [overview, setOverview] = useState<SetupOverview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<SetupOverview>("/api/setup/overview")
      .then((res) => {
        setOverview(res);
        setError("");
      })
      .catch((err) => setError(errorMessage(err)));
  }, [tick]);

  if (error) return <div className="panel" style={{ color: "#ff8fa3" }}>{error}</div>;
  if (!overview) return <div className="panel"><div className="loading" /></div>;

  return (
    <>
      <div className="grid-4">
        <div className="stat">
          <span>Total bot accounts</span>
          <b>{overview.bots.total}</b>
          <small>{overview.bots.paired} paired</small>
        </div>
        <div className="stat">
          <span>Connected bots</span>
          <b>{overview.bots.connected}</b>
          <small>{overview.bots.disconnected} disconnected</small>
        </div>
        <div className="stat">
          <span>Active dashboard users</span>
          <b>{overview.website.activeUsers}</b>
          <small>{overview.website.activeSessions} login sessions</small>
        </div>
        <div className="stat">
          <span>WhatsApp numbers</span>
          <b>{overview.whatsapp.connected}</b>
          <small>/ {overview.whatsapp.total} connected</small>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <h4>
            Recently paired bots <em>{overview.recentBots.length}</em>
          </h4>
          {overview.recentBots.length === 0 ? (
            <SectionEmpty>No bot has been paired yet.</SectionEmpty>
          ) : (
            <div className="rows">
              {overview.recentBots.map((bot) => (
                <div className="row" key={bot.id}>
                  <div className="grow">
                    <b>{bot.name}</b>
                    <small>
                      {bot.email} · paired {ago(bot.pairedAt)} · seen {ago(bot.lastSeenAt)}
                    </small>
                  </div>
                  <Pill value={bot.status} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <h4>
            Recently disconnected <em>{overview.recentDisconnected.length}</em>
          </h4>
          {overview.recentDisconnected.length === 0 ? (
            <SectionEmpty>Nothing disconnected.</SectionEmpty>
          ) : (
            <div className="rows">
              {overview.recentDisconnected.map((s) => (
                <div className="row" key={s.id}>
                  <div className="grow">
                    <b>
                      {s.label} <span style={{ color: "#8d8d97", fontWeight: 400 }}>{s.number}</span>
                    </b>
                    <small>
                      {s.email} · {ago(s.at)}
                    </small>
                  </div>
                  <Pill value={s.status} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="panel">
        <h4>
          Active website login sessions <em>{overview.website.activeSessions}</em>
        </h4>
        {overview.website.sessions.length === 0 ? (
          <SectionEmpty>No active sessions.</SectionEmpty>
        ) : (
          <div className="rows">
            {overview.website.sessions.map((s) => (
              <div className="row" key={s.id}>
                <div className="grow">
                  <b>{s.email}</b>
                  <small>
                    {s.ip || "unknown ip"} · {s.userAgent.slice(0, 60) || "unknown device"} · last seen{" "}
                    {ago(s.lastSeenAt)}
                  </small>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="fine">
          Website logins are tracked separately from WhatsApp connections. Signing out of the website never
          disconnects a paired bot.
        </p>
      </section>
    </>
  );
}

/* --------------------------------- accounts --------------------------------- */

function Accounts({ tick }: { tick: number }) {
  const [accounts, setAccounts] = useState<SetupAccount[]>([]);
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [manage, setManage] = useState<SetupAccount | null>(null);
  const [issued, setIssued] = useState<{ username: string; code: string; note: string } | null>(null);
  const toast = useToast();
  const copy = useCopy();

  const load = useCallback(() => {
    api
      .get<{ accounts: SetupAccount[] }>("/api/setup/accounts")
      .then((res) => setAccounts(res.accounts))
      .catch((err) => toast(errorMessage(err), "err"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load, tick]);

  const filtered = accounts.filter((a) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      a.username.includes(q) ||
      (a.linkedEmail || "").toLowerCase().includes(q) ||
      a.phone.includes(q) ||
      a.status.toLowerCase().includes(q)
    );
  });

  const act = async (account: SetupAccount, action: string) => {
    try {
      const res = await api.post<{ code?: string; delivery?: { note: string } }>(
        `/api/setup/accounts/${account.id}/actions`,
        { action },
      );
      if (action === "reset-code" && res.code) {
        setIssued({ username: account.username, code: res.code, note: res.delivery?.note || "" });
      } else {
        toast("Done", "ok");
      }
      load();
      setManage(null);
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  const remove = async (account: SetupAccount) => {
    try {
      await api.del(`/api/setup/accounts/${account.id}`);
      toast("Setup account deleted", "ok");
      setManage(null);
      load();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  return (
    <>
      <div className="page-h" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ fontSize: 18 }}>AUTHORISED <em>ACCOUNTS</em></h2>
          <p>You are the only person who can create, suspend or delete a Setup account.</p>
        </div>
        <button className="btn p" onClick={() => setAddOpen(true)}>
          + Add account
        </button>
      </div>

      <section className="panel">
        <div className="seg" style={{ marginBottom: 12 }}>
          <input
            className="input"
            placeholder="Search username, email, phone or status"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ background: "transparent", border: 0, outline: "none", color: "inherit", width: "100%" }}
          />
        </div>

        {filtered.length === 0 ? (
          <SectionEmpty>No Setup accounts yet. Create the first one.</SectionEmpty>
        ) : (
          <div className="rows">
            {filtered.map((account) => (
              <div className="row" key={account.id}>
                <div className="grow">
                  <b>
                    {account.username}
                    {account.displayName ? ` · ${account.displayName}` : ""}
                  </b>
                  <small>
                    {account.linkedEmail || "not linked"} · {account.phone || "no phone"} · code{" "}
                    {account.codePrefix} · {account.codeDelivery.toLowerCase().replace("_", " ")} · created{" "}
                    {ago(account.createdAt)}
                  </small>
                </div>
                <Pill value={STATUS_TONE[account.status] || account.status} />
                <button className="btn" onClick={() => setManage(account)}>
                  Manage
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {addOpen && (
        <AddAccount
          onClose={() => setAddOpen(false)}
          onCreated={(created) => {
            setAddOpen(false);
            setIssued({ username: created.account.username, code: created.code, note: created.delivery.note });
            load();
          }}
        />
      )}

      {manage && (
        <Modal title={`Manage ${manage.username}`} subtitle="Every action is authorised on the server and written to the activity log." onClose={() => setManage(null)}>
          <div className="rows">
            <div className="row">
              <div className="grow">
                <b>Status</b>
                <small>{manage.status} · linked to {manage.linkedEmail || "no main account"}</small>
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <b>Setup code</b>
                <small>
                  {manage.codePrefix} · expires {new Date(manage.codeExpiresAt).toLocaleString()} ·{" "}
                  {manage.codeDeliveryNote || manage.codeDelivery}
                </small>
              </div>
              <button className="btn" onClick={() => act(manage, "reset-code")}>
                Reset code
              </button>
            </div>
            <div className="row">
              <div className="grow">
                <b>Password</b>
                <small>Resetting the password also revokes active Setup sessions.</small>
              </div>
              <ResetPassword account={manage} onDone={() => { setManage(null); load(); }} />
            </div>
            <div className="row">
              <div className="grow">
                <b>Sessions</b>
                <small>Force a re-verification on every device.</small>
              </div>
              <button className="btn" onClick={() => act(manage, "revoke-sessions")}>
                Revoke sessions
              </button>
            </div>
            <div className="row">
              <div className="grow">
                <b>Main account link</b>
                <small>Unlinking keeps the Nexus account, only removes Setup access.</small>
              </div>
              <button className="btn" onClick={() => act(manage, "unlink")} disabled={!manage.linkedUserId}>
                Unlink
              </button>
            </div>
            <div className="row">
              <div className="grow">
                <b>Access</b>
                <small>Suspend blocks entry immediately; reactivate restores it.</small>
              </div>
              {manage.status === "SUSPENDED" ? (
                <button className="btn" onClick={() => act(manage, "reactivate")}>
                  Reactivate
                </button>
              ) : (
                <button className="btn" onClick={() => act(manage, "suspend")}>
                  Suspend
                </button>
              )}
            </div>
            <div className="row">
              <div className="grow">
                <b>Delete Setup account</b>
                <small>The Nexus website account is not deleted.</small>
              </div>
              <ConfirmButton label="Delete" confirmLabel="Delete permanently" onConfirm={() => remove(manage)} />
            </div>
          </div>
        </Modal>
      )}

      {issued && (
        <Modal
          title="Personal setup code"
          subtitle="Shown once. The same code is used for every later visit until you reset it."
          onClose={() => setIssued(null)}
        >
          <div className="code-big">{issued.code}</div>
          <p className="fine">{issued.note}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn p" onClick={() => copy(issued.code, "Setup code copied")}>
              Copy code
            </button>
            <button className="btn" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function AddAccount({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: { account: SetupAccount; code: string; delivery: { note: string } }) => void;
}) {
  const [form, setForm] = useState({ username: "", password: "", phone: "", displayName: "", mainEmail: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ account: SetupAccount; setupCode: string; delivery: { note: string } }>(
        "/api/setup/accounts",
        form,
      );
      toast("Setup account created", "ok");
      onCreated({ account: res.account, code: res.setupCode, delivery: res.delivery });
    } catch (err) {
      const fields = fieldErrors(err);
      setError(Object.values(fields)[0] || errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add authorised account" subtitle="They cannot register for Setup themselves — this is the only way in." onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>Username</span>
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="alex01" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="At least 10 chars, letter and number"
            required
          />
        </label>
        <label className="field">
          <span>Phone number (with country code)</span>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+254700000000" required />
        </label>
        <label className="field">
          <span>Display name (optional)</span>
          <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Alex" />
        </label>
        <label className="field">
          <span>Link to existing Nexus account (optional)</span>
          <input
            type="email"
            value={form.mainEmail}
            onChange={(e) => setForm({ ...form, mainEmail: e.target.value })}
            placeholder="alex@example.com"
          />
        </label>
        {error && <div className="err">{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn p" disabled={busy}>
            {busy ? "Creating…" : "Create account & issue code"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPassword({ account, onDone }: { account: SetupAccount; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/api/setup/accounts/${account.id}/actions`, { action: "reset-password", password });
      toast("Password reset", "ok");
      setOpen(false);
      onDone();
    } catch (err) {
      toast(errorMessage(err), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        Reset password
      </button>
      {open && (
        <Modal title="Reset Setup password" subtitle={`New password for ${account.username}`} onClose={() => setOpen(false)}>
          <label className="field">
            <span>New password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="btn p" disabled={busy || password.length < 10} onClick={submit}>
            {busy ? "Saving…" : "Save password"}
          </button>
        </Modal>
      )}
    </>
  );
}

/* --------------------------------- requests --------------------------------- */

function Requests({ tick }: { tick: number }) {
  const [requests, setRequests] = useState<SetupRequest[]>([]);
  const [error, setError] = useState("");
  const toast = useToast();

  const load = useCallback(() => {
    api
      .get<{ requests: SetupRequest[] }>("/api/setup/requests?status=PENDING")
      .then((res) => setRequests(res.requests))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(load, [load, tick]);

  const decide = async (request: SetupRequest, decision: "approve" | "reject") => {
    try {
      await api.post(`/api/setup/requests/${request.id}`, { decision });
      toast(decision === "approve" ? "Access approved" : "Access rejected", "ok");
      load();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  return (
    <section className="panel">
      <h4>
        Pending access requests <em>{requests.length}</em>
      </h4>
      {error && <div className="err">{error}</div>}
      {requests.length === 0 ? (
        <SectionEmpty>No pending requests.</SectionEmpty>
      ) : (
        <div className="rows">
          {requests.map((request) => (
            <div className="row" key={request.id}>
              <div className="grow">
                <b>{request.account.username}</b>
                <small>
                  {request.account.phone || "no phone"} ·{" "}
                  {request.requestedBy?.email || request.account.linkedEmail || "no main account"} ·{" "}
                  {ago(request.createdAt)}
                </small>
              </div>
              <button className="btn p" onClick={() => decide(request, "approve")}>
                Approve
              </button>
              <button className="btn" onClick={() => decide(request, "reject")}>
                Reject
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ----------------------------------- logs ----------------------------------- */

function Logs({ tick }: { tick: number }) {
  const [rows, setRows] = useState<SetupActivity[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<{ activity: SetupActivity[] }>("/api/setup/activity?limit=150")
      .then((res) => setRows(res.activity))
      .catch((err) => setError(errorMessage(err)));
  }, [tick]);

  return (
    <section className="panel">
      <h4>
        Setup activity <em>{rows.length}</em>
      </h4>
      {error && <div className="err">{error}</div>}
      {rows.length === 0 ? (
        <SectionEmpty>No Setup activity recorded yet.</SectionEmpty>
      ) : (
        <div className="rows">
          {rows.map((row) => (
            <div className="row" key={row.id}>
              <div className="grow">
                <b>{row.action.replace("setup.", "")}</b>
                <small>
                  {row.email || "system"} · {row.target || "—"} · {row.ip || "unknown ip"} · {ago(row.at)}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* --------------------------------- security --------------------------------- */

function Security() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (next !== confirm) {
      setError("The new tokens do not match.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/setup/owner-token", { current, next });
      toast("Owner token changed — Setup locked", "ok");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-2">
      <section className="panel">
        <h4>Change owner token</h4>
        <form className="form" onSubmit={submit}>
          <label className="field">
            <span>Current owner token</span>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label className="field">
            <span>New owner token</span>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={6} required />
          </label>
          <label className="field">
            <span>Confirm new token</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={6} required />
          </label>
          {error && <div className="err">{error}</div>}
          <button className="btn p" disabled={busy || !current || next.length < 6}>
            {busy ? "Saving…" : "Rotate token"}
          </button>
        </form>
      </section>

      <section className="panel">
        <h4>Security model</h4>
        <div className="rows">
          <div className="row">
            <div className="grow">
              <b>Two independent factors</b>
              <small>A signed-in Nexus session plus the owner token or a personal setup code.</small>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <b>Hashed at rest</b>
              <small>Codes and the owner token are bcrypt hashes; the browser never receives them.</small>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <b>Server-enforced lock</b>
              <small>Idle sessions expire after 20 minutes; revocation is immediate.</small>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <b>Bots are independent</b>
              <small>Locking Setup never disconnects a paired WhatsApp bot.</small>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* -------------------------------- user view -------------------------------- */

function MyAccount({ account }: { account: SetupAccount | null }) {
  if (!account) return <SectionEmpty>No Setup account is linked to this login.</SectionEmpty>;

  return (
    <div className="grid-2">
      <section className="panel">
        <h4>Your Setup account</h4>
        <div className="rows">
          <div className="row">
            <div className="grow">
              <b>{account.username}</b>
              <small>{account.displayName || "no display name"}</small>
            </div>
            <Pill value={STATUS_TONE[account.status] || account.status} />
          </div>
          <div className="row">
            <div className="grow">
              <b>{account.linkedEmail || "not linked"}</b>
              <small>linked Nexus account</small>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <b>{account.phone || "no phone"}</b>
              <small>code delivery number</small>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <b>{account.lastLoginAt ? ago(account.lastLoginAt) : "never"}</b>
              <small>last Setup sign-in</small>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <h4>What you can do here</h4>
        <p className="fine">
          Your Setup dashboard is limited to your own account and the bot sessions you own. Account creation,
          approvals and other people&apos;s data are owner-only and enforced on the server.
        </p>
        <div className="rows">
          <div className="row">
            <div className="grow">
              <b>Locking this area</b>
              <small>Leaves your WhatsApp bots connected — website sessions and bot sessions are separate.</small>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <b>Lost your code?</b>
              <small>Ask the owner to reset it; the previous code stops working immediately.</small>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
