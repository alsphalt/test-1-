"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { ConfirmButton, Modal, SectionEmpty, ago, clock, useNow, useToast } from "../ui";
import type { Bot, WaSession } from "../types";

const STATUS_HINT: Record<string, string> = {
  PAIRING_REQUESTED: "Contacting WhatsApp…",
  CONNECTING: "Opening a secure socket…",
  PAIRING_CODE: "Enter this code on your phone",
  CONNECTED: "Session is live",
  DISCONNECTED: "Connection dropped — reconnecting",
  RECONNECT_REQUESTED: "Restarting session",
  LOGGED_OUT: "Device unlinked",
  ERROR: "Needs attention",
};

const SHORT: Record<string, { text: string; cls: string }> = {
  CONNECTED: { text: "LIVE", cls: "ONLINE" },
  PAIRING_CODE: { text: "CODE", cls: "PAUSED" },
  PAIRING_REQUESTED: { text: "QUEUED", cls: "PAUSED" },
  CONNECTING: { text: "LINKING", cls: "PAUSED" },
  RECONNECT_REQUESTED: { text: "RESTART", cls: "PAUSED" },
  DISCONNECTED: { text: "OFFLINE", cls: "OFFLINE" },
  LOGGED_OUT: { text: "UNLINKED", cls: "OFFLINE" },
  ERROR: { text: "ERROR", cls: "ERROR" },
};

function WaPill({ status }: { status: string }) {
  const s = SHORT[status] || { text: status, cls: "" };
  return (
    <span className={`pill ${s.cls}`}>
      <i />
      {s.text}
    </span>
  );
}

function Uptime({ session }: { session: WaSession }) {
  const now = useNow(1000);
  const seconds = session.connectedAt
    ? Math.max(0, Math.floor((now - new Date(session.connectedAt).getTime()) / 1000))
    : 0;
  if (session.status !== "CONNECTED" || !seconds) return <span>—</span>;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return <span>{d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`}</span>;
}

export default function WhatsApp({ tick }: { tick: number }) {
  const [sessions, setSessions] = useState<WaSession[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const prev = useRef<Record<string, string>>({});
  const toast = useToast();

  useEffect(() => {
    api
      .get<{ bots: Bot[] }>("/api/bots")
      .then((res) => setBots(res.bots.filter((b) => b.paired && b.enabled)))
      .catch(() => undefined);
  }, [tick]);

  const load = () => {
    api
      .get<{ sessions: WaSession[] }>("/api/whatsapp/sessions")
      .then((res) => {
        setSessions(res.sessions);
        for (const s of res.sessions) {
          const before = prev.current[s.id];
          if (before === "CONNECTED" && ["DISCONNECTED", "ERROR", "LOGGED_OUT"].includes(s.status)) {
            toast(`${s.label} disconnected: ${s.statusDetail || s.statusLabel}`, "err");
          }
          if (before && before !== "CONNECTED" && s.status === "CONNECTED") {
            toast(`${s.label} connected as ${s.prettyPhone}`, "ok");
          }
          prev.current[s.id] = s.status;
        }
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(load, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fast poll while the worker is doing something, so codes and status land quickly.
  const transient = sessions.some((s) =>
    ["PAIRING_REQUESTED", "CONNECTING", "RECONNECT_REQUESTED"].includes(s.status),
  );
  useEffect(() => {
    if (!transient) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [transient]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ session: WaSession }>("/api/whatsapp/sessions", {
        label,
        phone,
        ...(botId ? { botId } : {}),
      });
      setCreateOpen(false);
      setLabel("");
      setPhone("");
      setBotId("");
      setDetailId(res.session.id);
      toast("Session created — WhatsApp is generating a pairing code.", "ok");
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: "pair" | "restart" | "logout") => {
    try {
      await api.post(`/api/whatsapp/sessions/${id}/${action}`);
      toast(
        action === "pair" ? "Asking WhatsApp for a new code…" : action === "restart" ? "Reconnecting…" : "Unlinking…",
        "ok",
      );
      load();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  const remove = async (id: string) => {
    try {
      await api.del(`/api/whatsapp/sessions/${id}`);
      toast("Session removed", "ok");
      load();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  const stats = useMemo(() => {
    const connected = sessions.filter((s) => s.status === "CONNECTED").length;
    const attention = sessions.filter((s) => ["DISCONNECTED", "ERROR"].includes(s.status)).length;
    return { connected, attention };
  }, [sessions]);

  const detail = sessions.find((s) => s.id === detailId) || null;

  return (
    <>
      <div className="page-h">
        <div>
          <h2>
            WHATSAPP <em>SESSIONS</em>
          </h2>
          <p>
            Every number is paired separately with a code WhatsApp issues — either on this server's worker or inside your
            own bot agent. Signing into Darknote never links WhatsApp.
          </p>
        </div>
        <button className="btn p" onClick={() => setCreateOpen(true)}>
          + Link number
        </button>
      </div>

      <div className="grid-4">
        <div className="stat">
          <span>Sessions</span>
          <b>{sessions.length}</b>
        </div>
        <div className="stat">
          <span>Connected</span>
          <b>{stats.connected}</b>
        </div>
        <div className="stat">
          <span>Needs attention</span>
          <b style={{ color: stats.attention ? "#ff5c7c" : undefined }}>{stats.attention}</b>
        </div>
        <div className="stat">
          <span>Agent</span>
          <b style={{ fontSize: 15 }}>
            <span className={`pill ${sessions.some((s) => s.workerLive) ? "ONLINE" : "OFFLINE"}`}>
              <i />
              {sessions.some((s) => s.workerLive) ? "LIVE" : "IDLE"}
            </span>
          </b>
        </div>
      </div>

      {stats.attention > 0 && (
        <div className="panel" style={{ borderColor: "rgba(255,92,124,.4)", background: "rgba(255,31,61,.06)" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ color: "#ff8fa3" }}>⚠ {stats.attention} session(s) lost their connection.</strong>
            <span className="mut" style={{ fontSize: 12 }}>
              The worker retries automatically with the stored credentials; use Restart to force it.
            </span>
          </div>
        </div>
      )}

      <section className="panel">
        <h4>
          Linked numbers <em>{sessions.length}</em>
        </h4>

        {loading ? (
          <div className="empty-state">Loading sessions…</div>
        ) : sessions.length === 0 ? (
          <SectionEmpty>
            No WhatsApp sessions yet. Link a number and enter the code WhatsApp shows in
            <br />
            <span className="kbd">Linked devices → Link with phone number</span>.
          </SectionEmpty>
        ) : (
          <div className="rows">
            {sessions.map((s) => (
              <div className="row" key={s.id} style={{ flexWrap: "wrap" }}>
                <div className="grow">
                  <b>
                    {s.label} <span style={{ color: "#8d8d97", fontWeight: 400 }}>{s.prettyPhone}</span>
                  </b>
                  <small>
                    {s.source === "BOT" ? `via ${s.botName || "bot agent"}` : "via server worker"} ·{" "}
                    {STATUS_HINT[s.status] || s.status} · uptime <Uptime session={s} /> · {s.disconnectCount} disconnects
                    {s.meNumber ? ` · paired as +${s.meNumber}` : ""}
                  </small>
                  {(s.pairError || (["DISCONNECTED", "ERROR"].includes(s.status) && s.statusDetail)) && (
                    <small style={{ color: "#ff8fa3" }}>{s.pairError || s.statusDetail}</small>
                  )}
                </div>
                <WaPill status={s.status} />
                <div className="btns">
                  <button className="btn sm" onClick={() => setDetailId(s.id)}>
                    {s.status === "PAIRING_CODE" ? "Show code" : "Details"}
                  </button>
                  {s.status !== "CONNECTED" && s.status !== "LOGGED_OUT" && (
                    <button className="btn sm" onClick={() => act(s.id, "pair")}>
                      Refresh code
                    </button>
                  )}
                  {s.status === "CONNECTED" && (
                    <button className="btn sm" onClick={() => act(s.id, "restart")}>
                      Restart
                    </button>
                  )}
                  {s.status === "CONNECTED" && (
                    <ConfirmButton label="Unlink" confirmLabel="Confirm unlink" onConfirm={() => act(s.id, "logout")} />
                  )}
                  <ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={() => remove(s.id)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {createOpen && (
        <Modal
          title="Link a WhatsApp number"
          subtitle="Darknote opens a real WhatsApp connection for this number and asks WhatsApp for a pairing code. The code appears here in a few seconds."
          onClose={() => setCreateOpen(false)}
        >
          <div className="form">
            {bots.length > 0 && (
              <div>
                <label htmlFor="wa-bot">Connect through</label>
                <select id="wa-bot" value={botId} onChange={(e) => setBotId(e.target.value)}>
                  <option value="">Server worker (this deployment)</option>
                  {bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} · bot agent
                    </option>
                  ))}
                </select>
                <div className="hint">
                  Bot agents issue the code from their own WhatsApp connection; the server worker uses this deployment.
                </div>
              </div>
            )}
            <div>
              <label htmlFor="wa-label">Session name</label>
              <input id="wa-label" value={label} maxLength={60} placeholder="Support line" onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div>
              <label htmlFor="wa-phone">Phone number (international, digits only)</label>
              <input
                id="wa-phone"
                value={phone}
                inputMode="tel"
                placeholder="447700900123"
                onChange={(e) => setPhone(e.target.value)}
              />
              <div className="hint">Include the country code. No + or spaces needed.</div>
            </div>
            {error && <div className="err">{error}</div>}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button
              className="btn p"
              onClick={create}
              disabled={busy || label.trim().length < 2 || phone.replace(/\D/g, "").length < 8}
            >
              {busy ? "Creating…" : "Get pairing code"}
            </button>
          </div>
        </Modal>
      )}

      {detail && <SessionDetail session={detail} tick={tick} onClose={() => setDetailId(null)} onChanged={load} />}
    </>
  );
}

function SessionDetail({
  session,
  tick,
  onClose,
  onChanged,
}: {
  session: WaSession;
  tick: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [logs, setLogs] = useState<{ id: string; level: string; message: string; createdAt: string }[]>([]);
  const [now, setNow] = useState(Date.now());
  const toast = useToast();
  const copy = () => {
    if (!session.pairingCode) return;
    navigator.clipboard.writeText(session.pairingCode).then(() => toast("Code copied", "ok")).catch(() => {});
  };

  useEffect(() => {
    api
      .get<{ logs: typeof logs }>(`/api/whatsapp/sessions/${session.id}/logs?limit=80`)
      .then((res) => setLogs(res.logs))
      .catch(() => undefined);
  }, [session.id, tick, session.updatedAt]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = session.pairingExpiresAt
    ? Math.max(0, Math.floor((new Date(session.pairingExpiresAt).getTime() - now) / 1000))
    : 0;

  const act = async (action: "pair" | "restart" | "logout") => {
    try {
      await api.post(`/api/whatsapp/sessions/${session.id}/${action}`);
      toast("Request sent", "ok");
      onChanged();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  return (
    <Modal title={session.label} subtitle={`${session.prettyPhone} · ${session.statusLabel}`} onClose={onClose} wide>
      <div className="grid-3" style={{ marginBottom: 14 }}>
        <div className="stat">
          <span>Status</span>
          <b style={{ fontSize: 14 }}>
            <WaPill status={session.status} />
          </b>
        </div>
        <div className="stat">
          <span>Uptime</span>
          <b style={{ fontSize: 16 }}>
            <Uptime session={session} />
          </b>
        </div>
        <div className="stat">
          <span>Disconnects</span>
          <b style={{ fontSize: 18 }}>{session.disconnectCount}</b>
        </div>
      </div>

      <div className="bot-grid">
        <div>
          <div className="pc-h">Pairing</div>

          {session.status === "PAIRING_CODE" && session.pairingCode ? (
            <>
              <div className="code-big">{session.pairingCode}</div>
              <div className="countdown" style={{ marginTop: 8 }}>
                {left > 0 ? `expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "expired — request a new code"}
              </div>
              <div className="pc-row" style={{ marginTop: 10 }}>
                <button className="btn sm" onClick={copy}>
                  Copy code
                </button>
                <button className="btn sm" onClick={() => act("pair")}>
                  New code
                </button>
              </div>
            </>
          ) : session.status === "CONNECTED" ? (
            <>
              <p className="ch-note">
                Linked as <b>+{session.meNumber || session.phone}</b>
                {session.platform ? ` · ${session.platform}` : ""}. Credentials are stored encrypted on the server and
                reconnect automatically after a restart.
              </p>
              <div className="pc-row">
                <button className="btn sm" onClick={() => act("restart")}>
                  Reconnect now
                </button>
                <ConfirmButton label="Unlink device" confirmLabel="Confirm unlink" onConfirm={() => act("logout")} />
              </div>
            </>
          ) : (
            <>
              <p className="ch-note">
                {session.status === "LOGGED_OUT"
                  ? "This device was unlinked. Request a new pairing code to link it again."
                  : "Waiting on the WhatsApp worker. If this does not change in ~30 seconds, make sure the worker process is running and has database access."}
              </p>
              <div className="pc-row">
                <button className="btn sm" onClick={() => act("pair")} disabled={session.status === "CONNECTING"}>
                  {session.status === "PAIRING_REQUESTED" ? "Request code" : "Get a new code"}
                </button>
                {session.status === "DISCONNECTED" && (
                  <button className="btn sm" onClick={() => act("restart")}>
                    Reconnect
                  </button>
                )}
              </div>
            </>
          )}

          {session.statusDetail && (
            <p className="ch-note" style={{ marginTop: 10, color: ["DISCONNECTED", "ERROR"].includes(session.status) ? "#ff8fa3" : undefined }}>
              {session.statusDetail}
            </p>
          )}

          <div className="pc-h">Session</div>
          <div className="rows">
            <div className="row">
              <div className="grow">
                <b>{session.workerLive ? "Worker attached" : "Worker not reporting"}</b>
                <small>last heartbeat {ago(session.lastSeenAt)}</small>
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <b>Created {ago(session.createdAt)}</b>
                <small>id {session.id}</small>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="pc-h">Session logs</div>
          <div className="logs">
            {logs.length === 0 ? (
              <div className="pf-empty">No events yet.</div>
            ) : (
              logs
                .slice()
                .reverse()
                .map((l) => (
                  <div key={l.id} className={`ln ${l.level === "ERROR" ? "ERR" : l.level === "WARN" ? "WARN" : ""}`}>
                    <span className="t">{clock(l.createdAt)}</span>
                    <span>{l.message}</span>
                  </div>
                ))
            )}
          </div>
          <p className="ch-note" style={{ marginTop: 8 }}>
            Credentials, keys and message metadata stay on the server. Logs are pruned after 7 days.
            {session.logCount ? ` ${session.logCount} events total.` : ""}
          </p>
        </div>
      </div>
    </Modal>
  );
}
