"use client";

import { useState } from "react";
import NexusCanvas from "./NexusCanvas";
import { Modal, useToast } from "./ui";
import { api, errorMessage } from "./api";
import type { Counts, Me } from "./types";

export type View = "overview" | "bots" | "whatsapp" | "files" | "integrations" | "admin" | "account";

const NAV: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "bots", label: "Bots" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "files", label: "Files" },
  { id: "integrations", label: "Integrations" },
  { id: "account", label: "Account" },
];

const AVATARS = ["◈", "☾", "⚡", "✦", "☠", "♞", "⚙", "✧"];

export function LivePill({ live, online }: { live: boolean; online?: number }) {
  return (
    <span className={`live-pill ${live ? "" : "off"}`} title={live ? "Realtime stream connected" : "Reconnecting…"}>
      <i />
      {live ? "Live" : "Offline"}
      {typeof online === "number" ? ` · ${online} online` : ""}
    </span>
  );
}

export default function Shell({
  me,
  counts,
  view,
  onView,
  onMe,
  onLogout,
  live,
  children,
}: {
  me: Me;
  counts?: Counts;
  view: View;
  onView: (v: View) => void;
  onMe: (m: Me) => void;
  onLogout: () => void;
  live: boolean;
  children: React.ReactNode;
}) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [name, setName] = useState(me.name);
  const [avatar, setAvatar] = useState(me.avatar || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const nav = me.role === "ADMIN" ? [...NAV, { id: "admin" as View, label: "Admin" }] : NAV;

  const saveProfile = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.patch<{ user: { name: string; avatar: string } }>("/api/auth/me", {
        name: name.trim(),
        avatar,
      });
      onMe({ ...me, name: res.user.name, avatar: res.user.avatar });
      toast("Profile saved", "ok");
      setProfileOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <NexusCanvas />
      <div className="nx">
        <header className="nx-top">
          <div className="nx-logo">
            <div className="mk">◈</div>
            <div>
              <b>
                DARKNOTE <em>NEXUS</em>
              </b>
              <small>Command layer</small>
            </div>
          </div>

          <nav className="nx-nav" aria-label="Sections">
            {nav.map((item) => (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? "on" : ""}
                onClick={() => onView(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                {view === item.id && <span className="dot" />}
                {item.label}
              </button>
            ))}
          </nav>

          <div className="nx-spacer" />

          <LivePill live={live} online={counts?.botsOnline} />

          <div className="who">
            <button type="button" className="av-btn" onClick={() => setProfileOpen(true)} title="Profile">
              <span className="av">{me.avatar || me.name.slice(0, 1).toUpperCase()}</span>
              <span className="uname">{me.name}</span>
              {me.role === "ADMIN" && <span className="role">admin</span>}
            </button>
            <button type="button" className="icon-btn" onClick={onLogout} title="Sign out" aria-label="Sign out">
              ⏻
            </button>
          </div>
        </header>

        <main className="nx-main">{children}</main>
        <footer className="nx-foot">Darknote Nexus · persistent accounts · {counts ? `${counts.bots} bots` : ""}</footer>
      </div>

      {profileOpen && (
        <Modal
          title="Your profile"
          subtitle="The avatar and name are stored on your account and appear on every device you sign in from."
          onClose={() => setProfileOpen(false)}
        >
          <div className={`av big`}>{avatar || name.slice(0, 1).toUpperCase()}</div>

          <div className="av-grid">
            {AVATARS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={avatar === emoji ? "sel" : ""}
                onClick={() => setAvatar(emoji)}
                aria-label={`Use ${emoji} as avatar`}
              >
                {emoji}
              </button>
            ))}
          </div>

          <div className="form">
            <div>
              <label htmlFor="pf-name">Display name</label>
              <input id="pf-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="hint">Signed in as {me.email}</div>
            {error && <div className="err">{error}</div>}
          </div>

          <div className="actions">
            <button type="button" className="btn" onClick={() => setProfileOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn p" onClick={saveProfile} disabled={busy || name.trim().length < 2}>
              {busy ? "Saving…" : "Save profile"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
