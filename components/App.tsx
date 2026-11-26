"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AuthScreen from "./AuthScreen";
import Intro from "./Intro";
import Shell, { type View } from "./Shell";
import Overview from "./views/Overview";
import Bots from "./views/Bots";
import WhatsApp from "./views/WhatsApp";
import Files from "./views/Files";
import Integrations from "./views/Integrations";
import Admin from "./views/Admin";
import Account from "./views/Account";
import { ToastProvider, useToast } from "./ui";
import { api } from "./api";
import type { Counts, Me, MeResponse } from "./types";

type Phase = "boot" | "intro" | "auth" | "app";

function Nexus() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [me, setMe] = useState<Me | null>(null);
  const [counts, setCounts] = useState<Counts | undefined>();
  const [view, setView] = useState<View>("overview");
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const toast = useToast();

  const refreshMe = useCallback(async () => {
    try {
      const res = await api.get<MeResponse>("/api/auth/me");
      if (res.user) {
        setMe(res.user);
        setCounts(res.counts);
      }
      return Boolean(res.user);
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .get<MeResponse>("/api/auth/me")
      .then((res) => {
        if (!alive) return;
        if (res.user) {
          setMe(res.user);
          setCounts(res.counts);
          setPhase("app");
        } else {
          setPhase("intro");
        }
      })
      .catch(() => alive && setPhase("intro"));
    return () => {
      alive = false;
    };
  }, []);

  /* --------------------------------- realtime -------------------------------- */
  useEffect(() => {
    if (phase !== "app" || !me) return;

    const source = new EventSource("/api/events");
    esRef.current = source;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshMe();
      }, 600);
    };

    source.onopen = () => setLive(true);

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (!data.type || data.type === "ready" || data.type === "ping") {
          if (data.type === "ready") setLive(true);
          return;
        }
        if (data.type === "bye") return;
        setTick((t) => t + 1);
        scheduleRefresh();
      } catch {
        /* ignore malformed frames */
      }
    };

    source.onerror = () => {
      setLive(false); // EventSource reconnects on its own
    };

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      source.close();
      esRef.current = null;
      setLive(false);
    };
  }, [phase, me, refreshMe]);

  /* ---------------------------------- actions -------------------------------- */
  const logout = async () => {
    try {
      await api.post("/api/auth/logout");
    } catch {
      /* the cookie is cleared server-side when possible */
    }
    esRef.current?.close();
    setMe(null);
    setCounts(undefined);
    setView("overview");
    setPhase("auth");
    toast("Signed out", "ok");
  };

  useEffect(() => {
    const onUnauthorized = () => {
      setMe(null);
      setCounts(undefined);
      setPhase("auth");
    };
    window.addEventListener("dnx:unauthorized", onUnauthorized);
    return () => window.removeEventListener("dnx:unauthorized", onUnauthorized);
  }, []);

  if (phase === "boot") {
    return (
      <div className="center" style={{ minHeight: "100dvh" }}>
        <div style={{ textAlign: "center", color: "#8d8d97" }}>
          <div className="loading" style={{ margin: "0 auto 10px" }} />
          <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: 11, letterSpacing: ".24em" }}>DARKNOTE NEXUS</div>
        </div>
      </div>
    );
  }

  if (phase === "intro") {
    return <Intro onEnter={() => setPhase("auth")} />;
  }

  if (phase === "auth" || !me) {
    return (
      <AuthScreen
        onAuthed={(user) => {
          setMe(user);
          setPhase("app");
          void refreshMe();
        }}
      />
    );
  }

  return (
    <Shell me={me} counts={counts} view={view} onView={setView} onMe={setMe} onLogout={logout} live={live}>
      {view === "overview" && <Overview me={me} counts={counts} tick={tick} onView={setView} />}
      {view === "bots" && <Bots tick={tick} />}
      {view === "whatsapp" && <WhatsApp tick={tick} />}
      {view === "files" && <Files tick={tick} />}
      {view === "integrations" && <Integrations tick={tick} />}
      {view === "admin" && (me.role === "ADMIN" ? <Admin me={me} tick={tick} /> : <div className="panel">Administrator access required.</div>)}
      {view === "account" && <Account me={me} counts={counts} tick={tick} onLogout={logout} />}
    </Shell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Nexus />
    </ToastProvider>
  );
}
