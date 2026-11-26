"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { ConfirmButton, Pill, SectionEmpty, ago, useToast } from "../ui";
import type { Counts, Me, SessionRow } from "../types";

function device(ua: string): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  return `${browser} · ${os}`;
}

export default function Account({
  me,
  counts,
  tick,
  onLogout,
}: {
  me: Me;
  counts?: Counts;
  tick: number;
  onLogout: () => void;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState("");
  const toast = useToast();

  const load = () => {
    api
      .get<{ sessions: SessionRow[] }>("/api/auth/sessions")
      .then((res) => setSessions(res.sessions))
      .catch((err) => setError(errorMessage(err)));
  };

  useEffect(load, [tick]);

  const revoke = async (id: string) => {
    try {
      await api.del(`/api/auth/sessions/${id}`);
      toast("Session revoked", "ok");
      load();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  const revokeOthers = async () => {
    try {
      await api.del("/api/auth/sessions");
      toast("Other sessions signed out", "ok");
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
            ACCOUNT <em>SECURITY</em>
          </h2>
          <p>Sessions are tracked server-side. Revoking one signs that device out on its next request.</p>
        </div>
        <button className="btn d" onClick={onLogout}>
          Sign out
        </button>
      </div>

      <div className="grid-2">
        <section className="panel">
          <h4>
            Active sessions <em>{sessions.length}</em>
          </h4>
          {error && <div className="err" style={{ marginBottom: 10 }}>{error}</div>}
          {sessions.length === 0 ? (
            <SectionEmpty>No active sessions found.</SectionEmpty>
          ) : (
            <div className="rows">
              {sessions.map((s) => (
                <div className="row" key={s.id}>
                  <div className="grow">
                    <b>
                      {device(s.userAgent)} {s.current && <span style={{ color: "#5cffb0", fontSize: 11 }}>· this device</span>}
                    </b>
                    <small>
                      {s.ip || "unknown ip"} · started {ago(s.createdAt)} · last seen {ago(s.lastSeenAt)}
                    </small>
                  </div>
                  {s.current ? (
                    <Pill value="ACTIVE" />
                  ) : (
                    <ConfirmButton label="Revoke" confirmLabel="Confirm" onConfirm={() => revoke(s.id)} />
                  )}
                </div>
              ))}
            </div>
          )}

          {sessions.length > 1 && (
            <button className="btn" style={{ marginTop: 12 }} onClick={revokeOthers}>
              Sign out every other device
            </button>
          )}
        </section>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <section className="panel">
            <h4>Identity</h4>
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
                  <b>Member since</b>
                  <small>{me.createdAt ? new Date(me.createdAt).toLocaleString() : "—"}</small>
                </div>
              </div>
              <div className="row">
                <div className="grow">
                  <b>Last login</b>
                  <small>{me.lastLoginAt ? new Date(me.lastLoginAt).toLocaleString() : "this session"}</small>
                </div>
              </div>
            </div>
            <p className="mut" style={{ marginTop: 12 }}>
              Change your display name and avatar from the profile chip in the top bar.
            </p>
          </section>

          <section className="panel">
            <h4>Workspace</h4>
            <div className="grid-3">
              <div className="stat">
                <span>Bots</span>
                <b>{counts?.bots ?? 0}</b>
              </div>
              <div className="stat">
                <span>Files</span>
                <b>{counts?.files ?? 0}</b>
              </div>
              <div className="stat">
                <span>APIs</span>
                <b>{counts?.integrations ?? 0}</b>
              </div>
            </div>
            <p className="mut" style={{ marginTop: 12 }}>
              Passwords are hashed with bcrypt (cost 12). Sessions use signed, HTTP-only cookies backed by a database row.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
