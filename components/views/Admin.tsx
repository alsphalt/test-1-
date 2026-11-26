"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { ConfirmButton, Pill, SectionEmpty, ago, fmtBytes, useDebounced, useToast } from "../ui";
import type { AdminStats, AdminUser, AuditRow, Me } from "../types";

export default function Admin({ me, tick }: { me: Me; tick: number }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const q = useDebounced(query, 350);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    api
      .get<AdminStats>("/api/admin/stats")
      .then(setStats)
      .catch((err) => setError(errorMessage(err)));
    api
      .get<{ logs: AuditRow[] }>("/api/admin/audit?limit=20")
      .then((res) => setAudit(res.logs))
      .catch(() => undefined);
  }, [tick]);

  useEffect(() => {
    setPage(1);
  }, [q]);

  useEffect(() => {
    api
      .get<{ users: AdminUser[]; total: number; pages: number; page: number }>(
        `/api/admin/users?page=${page}&limit=20&q=${encodeURIComponent(q)}`,
      )
      .then((res) => {
        setUsers(res.users);
        setTotal(res.total);
        setPages(res.pages);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [page, q, tick]);

  const patch = async (user: AdminUser, body: { role?: string; status?: string }) => {
    try {
      await api.patch(`/api/admin/users/${user.id}`, body);
      toast(`Updated ${user.email}`, "ok");
      const res = await api.get<{ users: AdminUser[]; total: number; pages: number }>(
        `/api/admin/users?page=${page}&limit=20&q=${encodeURIComponent(q)}`,
      );
      setUsers(res.users);
      setTotal(res.total);
      setPages(res.pages);
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  const remove = async (user: AdminUser) => {
    try {
      await api.del(`/api/admin/users/${user.id}`);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      setTotal((t) => Math.max(0, t - 1));
      toast("Account deleted", "ok");
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  const maxSignup = Math.max(1, ...(stats?.series.signups || [1]));

  return (
    <>
      <div className="page-h">
        <div>
          <h2>
            ADMIN <em>CONTROL</em>
          </h2>
          <p>Server-side operators only. Every action here is written to the audit log.</p>
        </div>
        <span className="hint-line">role · {me.role}</span>
      </div>

      {error && <div className="panel" style={{ color: "#ff8fa3" }}>{error}</div>}

      <div className="grid-4">
        <div className="stat">
          <span>Users</span>
          <b>{stats?.totals.users ?? "—"}</b>
        </div>
        <div className="stat">
          <span>Sessions</span>
          <b>{stats?.totals.activeSessions ?? "—"}</b>
        </div>
        <div className="stat">
          <span>Bots online</span>
          <b>
            {stats?.totals.botsOnline ?? "—"}
            <small>/ {stats?.totals.bots ?? 0}</small>
          </b>
        </div>
        <div className="stat">
          <span>Storage</span>
          <b style={{ fontSize: 17 }}>{stats ? fmtBytes(stats.totals.storageBytes) : "—"}</b>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <h4>
            Signups · last 7 days <em>{stats ? stats.series.signups.reduce((a, b) => a + b, 0) : 0}</em>
          </h4>
          <div className="spark-bars">
            {(stats?.series.signups || []).map((value, i) => (
              <i key={i} style={{ height: `${Math.max(4, (value / maxSignup) * 100)}%` }} title={`${value} signups`} />
            ))}
          </div>
          <div className="spark-days">
            {(stats?.series.days || []).map((d) => (
              <span key={d}>{d.slice(5)}</span>
            ))}
          </div>

          <h4 style={{ marginTop: 18 }}>Log activity</h4>
          <div className="rows">
            {(stats?.series.activity || []).slice(-4).map((a, i) => (
              <div className="row" key={i}>
                <div className="grow">
                  <b>{a.info} info lines</b>
                  <small>{a.error} errors</small>
                </div>
                <span className="pill ERROR">
                  <i />
                  {a.error}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h4>Recent audit</h4>
          {audit.length === 0 ? (
            <SectionEmpty>No audit entries yet.</SectionEmpty>
          ) : (
            <div className="rows">
              {audit.slice(0, 10).map((row) => (
                <div className="row" key={row.id}>
                  <div className="grow">
                    <b>{row.action}</b>
                    <small>
                      {row.user?.email || "anonymous"} · {row.target || "—"} · {ago(row.createdAt)}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="panel">
        <h4>
          Users <em>{total}</em>
        </h4>

        <div className="form" style={{ marginBottom: 12 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by email or name…"
            aria-label="Search users"
            spellCheck={false}
          />
        </div>

        {users.length === 0 ? (
          <SectionEmpty>No accounts match that search.</SectionEmpty>
        ) : (
          <div className="rows">
            {users.map((u) => (
              <div className="row" key={u.id} style={{ flexWrap: "wrap" }}>
                <div className="grow">
                  <b>
                    {u.name} {u.id === me.id && <span style={{ color: "#8d8d97", fontWeight: 400 }}>(you)</span>}
                  </b>
                  <small>
                    {u.email} · joined {ago(u.createdAt)} · last login {ago(u.lastLoginAt)} · {u._count?.bots ?? 0} bots ·{" "}
                    {u._count?.files ?? 0} files
                  </small>
                </div>
                <Pill value={u.role} />
                <Pill value={u.status} />
                <div className="btns">
                  <button
                    className="btn sm"
                    onClick={() => patch(u, { role: u.role === "ADMIN" ? "USER" : "ADMIN" })}
                    disabled={u.id === me.id}
                  >
                    {u.role === "ADMIN" ? "Demote" : "Promote"}
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => patch(u, { status: u.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE" })}
                    disabled={u.id === me.id}
                  >
                    {u.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                  </button>
                  <ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={() => remove(u)} disabled={u.id === me.id} />
                </div>
              </div>
            ))}
          </div>
        )}

        {pages > 1 && (
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14, alignItems: "center" }}>
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Prev
            </button>
            <span style={{ fontSize: 12, color: "#8d8d97" }}>
              {page} / {pages}
            </span>
            <button className="btn sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        )}
      </section>
    </>
  );
}
