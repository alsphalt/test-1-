"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Pill, ago, clock, SectionEmpty } from "../ui";
import type { Bot, BotLog, Counts, Me } from "../types";
import type { View } from "../Shell";

export default function Overview({
  me,
  counts,
  tick,
  onView,
}: {
  me: Me;
  counts?: Counts;
  tick: number;
  onView: (v: View) => void;
}) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [logs, setLogs] = useState<BotLog[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get<{ bots: Bot[] }>("/api/bots"),
      api.get<{ logs: BotLog[] }>("/api/logs?limit=40"),
    ])
      .then(([b, l]) => {
        if (!alive) return;
        setBots(b.bots);
        setLogs(l.logs);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, [tick]);

  const online = useMemo(
    () => bots.filter((b) => b.status === "ONLINE" && b.lastSeenAt && Date.now() - new Date(b.lastSeenAt).getTime() < 120_000),
    [bots],
  );

  const focus = online[0] || bots[0] || null;
  const focusLogs = useMemo(
    () => (focus ? logs.filter((l) => l.botId === focus.id).slice(0, 8).reverse() : []),
    [focus, logs],
  );

  const messages = bots.reduce((sum, b) => sum + b.messagesSent, 0);
  const errors = bots.reduce((sum, b) => sum + b.errors, 0);

  return (
    <>
      <div className="page-h">
        <div>
          <h2>
            COMMAND <em>LAYER</em>
          </h2>
          <p>
            Signed in as {me.email} · {me.role === "ADMIN" ? "administrator" : "operator"}
          </p>
        </div>
        <div className="hint-line">{online.length ? `${online.length} live link${online.length > 1 ? "s" : ""}` : "no live links"}</div>
      </div>

      <div className="grid-2">
        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <section className="panel">
            <h4>
              Live feed <em>{focus ? focus.name : "no bot"}</em>
            </h4>

            <div className={`stream ${online.length ? "on" : ""}`}>
              {online.length > 0 && <div className="live-badge">LIVE</div>}

              <div className="s-off">
                No bot is transmitting.
                <small>Pair a bot and send a heartbeat to see its stream here.</small>
              </div>

              <div className="s-on">
                {focusLogs.length ? (
                  <div className="stream-log">
                    {focusLogs.map((l) => (
                      <div key={l.id} className={`pf-line ${l.level === "ERROR" ? "ERR" : l.level === "WARN" ? "WARN" : ""}`}>
                        <span className="t">{clock(l.createdAt)}</span>
                        {l.message}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="center" style={{ height: "100%" }}>
                    <div className="eq" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="stream-meta">
              <span>
                {focus ? (
                  <>
                    <Pill value={focus.status} /> &nbsp;{focus.version ? `v${focus.version}` : "version unknown"} · seen {ago(focus.lastSeenAt)}
                  </>
                ) : (
                  "Nothing paired yet"
                )}
              </span>
              <span>
                {focus ? `${focus.messagesSent.toLocaleString()} messages · ${focus.errors} errors` : ""}
              </span>
            </div>
          </section>

          <div className="grid-4">
            <div className="stat">
              <span>Bots</span>
              <b>
                {bots.length}
                <small>{online.length} online</small>
              </b>
            </div>
            <div className="stat">
              <span>Messages</span>
              <b>{messages.toLocaleString()}</b>
            </div>
            <div className="stat">
              <span>Errors</span>
              <b>{errors.toLocaleString()}</b>
            </div>
            <div className="stat">
              <span>Files</span>
              <b>{counts?.files ?? 0}</b>
            </div>
          </div>

          <section className="panel">
            <h4>
              Bot panel feed <span className={`pf-st ${online.length ? "on" : ""}`}>{online.length ? "streaming" : "idle"}</span>
            </h4>
            <div className="pf-list">
              {logs.length === 0 ? (
                <div className="pf-empty">
                  {loaded ? "No log lines yet. Pair a bot and it will report here." : "Loading…"}
                </div>
              ) : (
                logs.map((l) => (
                  <div key={l.id} className={`pf-line ${l.level}`}>
                    <span className="t">{clock(l.createdAt)}</span>
                    {l.bot?.name ? `[${l.bot.name}] ` : ""}
                    {l.message}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <section className="panel">
            <h4>Quick actions</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button className="btn p block" onClick={() => onView("bots")}>
                Pair a new bot
              </button>
              <button className="btn block" onClick={() => onView("files")}>
                Upload a file
              </button>
              <button className="btn block" onClick={() => onView("integrations")}>
                Connect an API
              </button>
              <button className="btn block" onClick={() => onView("account")}>
                Manage sessions
              </button>
            </div>
            <p className="mut" style={{ marginTop: 12 }}>
              Everything here is stored server-side — reload or sign in elsewhere and the state follows you.
            </p>
          </section>

          <section className="panel">
            <h4>
              Fleet <em>{bots.length}</em>
            </h4>
            {bots.length === 0 ? (
              <SectionEmpty>No bots yet. Create one and hand the pairing code to your connector.</SectionEmpty>
            ) : (
              <div className="rows">
                {bots.slice(0, 5).map((b) => (
                  <div className="row" key={b.id}>
                    <div className="grow">
                      <b>{b.name}</b>
                      <small>seen {ago(b.lastSeenAt)} · {b.messagesSent.toLocaleString()} msgs</small>
                    </div>
                    <Pill value={b.status} />
                  </div>
                ))}
              </div>
            )}
            {bots.length > 5 && (
              <button className="btn sm" style={{ marginTop: 10 }} onClick={() => onView("bots")}>
                View all {bots.length}
              </button>
            )}
          </section>

          <section className="panel">
            <h4>Account</h4>
            <div className="rows">
              <div className="row">
                <div className="grow">
                  <b>{me.name}</b>
                  <small>{me.email}</small>
                </div>
                <Pill value={me.role} />
              </div>
              <div className="row">
                <div className="grow">
                  <b>{counts?.sessions ?? 0} active session{(counts?.sessions ?? 0) === 1 ? "" : "s"}</b>
                  <small>{counts?.integrations ?? 0} integrations · {counts?.logs ?? 0} log lines</small>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
