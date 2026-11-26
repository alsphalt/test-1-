"use client";

import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api";
import { ConfirmButton, Modal, Pill, SectionEmpty, ago, clock, useCopy, useNow, useToast } from "../ui";
import type { Bot, BotLog, BotStatus } from "../types";

type Detail = { bot: Bot; logs: number; recent: BotLog[] };

export default function Bots({ tick }: { tick: number }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const load = () => {
    api
      .get<{ bots: Bot[] }>("/api/bots")
      .then((res) => setBots(res.bots))
      .catch((err) => toast(errorMessage(err), "err"))
      .finally(() => setLoading(false));
  };

  useEffect(load, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ bot: Bot }>("/api/bots", { name: name.trim(), description: description.trim() });
      setCreateOpen(false);
      setName("");
      setDescription("");
      load();
      setDetailId(res.bot.id);
      toast("Bot created — pair it to connect.", "ok");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (bot: Bot) => {
    try {
      await api.patch(`/api/bots/${bot.id}`, { enabled: !bot.enabled });
      load();
      toast(bot.enabled ? "Bot paused" : "Bot enabled", "ok");
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  const remove = async (bot: Bot) => {
    try {
      await api.del(`/api/bots/${bot.id}`);
      toast("Bot deleted", "ok");
      load();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  return (
    <>
      <div className="page-h">
        <div>
          <h2>
            PAIRED <em>BOTS</em>
          </h2>
          <p>Each bot gets a one-time pairing code, then a revocable token used for heartbeats and logs.</p>
        </div>
        <button className="btn p" onClick={() => setCreateOpen(true)}>
          + New bot
        </button>
      </div>

      <section className="panel">
        <h4>
          Fleet <em>{bots.length}</em>
        </h4>

        {loading ? (
          <div className="empty-state">Loading bots…</div>
        ) : bots.length === 0 ? (
          <SectionEmpty>
            No bots yet.
            <br />
            Create one, then run the connector on the machine that should report in.
          </SectionEmpty>
        ) : (
          <div className="rows">
            {bots.map((bot) => (
              <div className="row" key={bot.id}>
                <div className="grow">
                  <b>{bot.name}</b>
                  <small>
                    {bot.description || "No description"} · {bot.paired ? `token ${bot.tokenPrefix}…` : "not paired"} · seen {ago(bot.lastSeenAt)}
                  </small>
                </div>
                <Pill value={bot.enabled ? bot.status : "PAUSED"} />
                <div className="btns">
                  <button className="btn sm" onClick={() => setDetailId(bot.id)}>
                    Details
                  </button>
                  <button className="btn sm" onClick={() => toggle(bot)}>
                    {bot.enabled ? "Pause" : "Enable"}
                  </button>
                  <ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={() => remove(bot)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {createOpen && (
        <Modal
          title="New bot"
          subtitle="Give it a name you will recognise. Nothing is sent to it until you pair it."
          onClose={() => setCreateOpen(false)}
        >
          <div className="form">
            <div>
              <label htmlFor="bot-name">Name</label>
              <input id="bot-name" value={name} maxLength={60} placeholder="relay-eu-1" onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label htmlFor="bot-desc">Description (optional)</label>
              <input
                id="bot-desc"
                value={description}
                maxLength={300}
                placeholder="What does this bot do?"
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {error && <div className="err">{error}</div>}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button className="btn p" onClick={create} disabled={busy || name.trim().length < 2}>
              {busy ? "Creating…" : "Create bot"}
            </button>
          </div>
        </Modal>
      )}

      {detailId && <BotDetail id={detailId} tick={tick} onClose={() => setDetailId(null)} onChanged={load} />}
    </>
  );
}

function BotDetail({ id, tick, onClose, onChanged }: { id: string; tick: number; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const copy = useCopy();
  const now = useNow(1000);

  const load = () => {
    api
      .get<Detail>(`/api/bots/${id}`)
      .then(setDetail)
      .catch((err) => setError(errorMessage(err)));
  };

  useEffect(load, [id, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const bot = detail?.bot;
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const remaining = useMemo(() => {
    if (!code) return 0;
    return Math.max(0, Math.floor((new Date(code.expiresAt).getTime() - now) / 1000));
  }, [code, now]);

  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ code: string; expiresAt: string }>(`/api/bots/${id}/pair`);
      setCode({ code: res.code, expiresAt: res.expiresAt });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    try {
      await api.post(`/api/bots/${id}/revoke`);
      toast("Token revoked — the bot can no longer report.", "ok");
      load();
      onChanged();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  const toggle = async () => {
    if (!bot) return;
    try {
      await api.patch(`/api/bots/${id}`, { enabled: !bot.enabled });
      load();
      onChanged();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  return (
    <Modal title={bot ? bot.name : "Bot"} subtitle={bot?.description || "Paired device"} onClose={onClose} wide>
      {!detail ? (
        <div className="empty-state">{error || "Loading…"}</div>
      ) : (
        <>
          <div className="grid-3" style={{ marginBottom: 14 }}>
            <div className="stat">
              <span>Status</span>
              <b style={{ fontSize: 15 }}>
                <Pill value={bot?.enabled ? (bot?.status as BotStatus) : "PAUSED"} />
              </b>
            </div>
            <div className="stat">
              <span>Messages</span>
              <b style={{ fontSize: 18 }}>{(bot?.messagesSent || 0).toLocaleString()}</b>
            </div>
            <div className="stat">
              <span>Errors</span>
              <b style={{ fontSize: 18 }}>{bot?.errors || 0}</b>
            </div>
          </div>

          <div className="bot-grid">
            <div>
              <div className="pc-h">Pairing</div>
              {bot?.paired ? (
                <>
                  <p className="ch-note">
                    Token <code>{bot.tokenPrefix}…</code> is active. It was shown once at pairing and is stored only as a
                    hash, so it cannot be displayed again.
                  </p>
                  <div className="pc-row">
                    <button className="btn" onClick={generate} disabled={busy}>
                      {busy ? "Working…" : "Issue new pairing code"}
                    </button>
                    <ConfirmButton label="Revoke token" confirmLabel="Confirm revoke" onConfirm={revoke} />
                  </div>
                </>
              ) : (
                <>
                  <p className="ch-note">This bot has no token yet. Generate a code and redeem it from the bot host.</p>
                  <div className="pc-row">
                    <button className="btn" onClick={generate} disabled={busy}>
                      {busy ? "Working…" : "Generate pairing code"}
                    </button>
                  </div>
                </>
              )}

              {code && remaining > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="code-big">{code.code}</div>
                  <div className="countdown" style={{ marginTop: 8 }}>
                    expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
                  </div>
                  <div className="pc-row" style={{ marginTop: 10 }}>
                    <button className="btn sm" onClick={() => copy(code.code, "Pairing code copied")}>
                      Copy code
                    </button>
                  </div>
                  <pre
                    style={{
                      marginTop: 12,
                      background: "rgba(0,0,0,.75)",
                      border: "1px solid rgba(255,255,255,.12)",
                      borderRadius: 10,
                      padding: 12,
                      fontSize: 11.5,
                      lineHeight: 1.6,
                      overflowX: "auto",
                      color: "#ffd0e6",
                    }}
                  >
{`curl -X POST ${origin}/api/bots/pair \\
  -H 'content-type: application/json' \\
  -d '{"code":"${code.code}","version":"1.0.0"}'`}
                  </pre>
                  <p className="ch-note" style={{ marginTop: 8 }}>
                    The response contains the bot token once. Store it on the bot host only.
                  </p>
                </div>
              )}

              {code && remaining === 0 && <p className="pc-status">That code expired — generate a fresh one.</p>}
              {error && <p className="pc-status">{error}</p>}

              <div className="pc-h">Heartbeat</div>
              <pre
                style={{
                  background: "rgba(0,0,0,.75)",
                  border: "1px solid rgba(255,255,255,.12)",
                  borderRadius: 10,
                  padding: 12,
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  overflowX: "auto",
                  color: "#ffd0e6",
                }}
              >
{`curl -X POST ${origin}/api/bots/heartbeat \\
  -H 'authorization: Bearer <BOT_TOKEN>' \\
  -H 'content-type: application/json' \\
  -d '{"status":"ONLINE","message":"poll ok","version":"1.0.0","messagesSent":42,"errors":0}'`}
              </pre>

              <div className="pc-row" style={{ marginTop: 12 }}>
                <button className="btn sm" onClick={toggle}>
                  {bot?.enabled ? "Pause bot" : "Enable bot"}
                </button>
              </div>
            </div>

            <div>
              <div className="pc-h">Recent log lines · {detail.logs}</div>
              <div className="logs">
                {detail.recent.length === 0 ? (
                  <div className="pf-empty">No log lines yet.</div>
                ) : (
                  detail.recent
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
                Last seen {ago(bot?.lastSeenAt)} · created {bot ? new Date(bot.createdAt).toLocaleDateString() : "—"}
              </p>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
