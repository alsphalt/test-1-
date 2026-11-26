"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/* ---------------------------------- toast --------------------------------- */

type ToastKind = "info" | "ok" | "err";
type Toast = { id: number; message: string; kind: ToastKind };

const ToastCtx = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const push = useCallback((message: string, kind: ToastKind = "info") => {
    setToast({ id: Date.now(), message, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3600);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className={`toast ${toast ? "show" : ""} ${toast?.kind === "err" ? "err" : toast?.kind === "ok" ? "ok" : ""}`} role="status" aria-live="polite">
        {toast?.message || ""}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/* ---------------------------------- modal --------------------------------- */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("locked");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("locked");
    };
  }, [onClose]);

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal ${wide ? "wide" : ""}`}>
        <button className="x" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3>{title}</h3>
        {subtitle ? <p className="sub-line">{subtitle}</p> : null}
        {children}
      </div>
    </div>
  );
}

/* --------------------------------- helpers -------------------------------- */

export function Pill({ value }: { value: string }) {
  const label = value || "UNKNOWN";
  return (
    <span className={`pill ${label}`}>
      <i />
      {label}
    </span>
  );
}

export function fmtBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function ago(value?: string | null): string {
  if (!value) return "never";
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return "unknown";
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(value).toLocaleDateString();
}

export function clock(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toLocaleTimeString([], { hour12: false });
}

export function useCopy() {
  const toast = useToast();
  return async (text: string, message = "Copied") => {
    try {
      await navigator.clipboard.writeText(text);
      toast(message, "ok");
    } catch {
      toast("Copy failed — select the text manually.", "err");
    }
  };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function SectionEmpty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = "btn sm d",
  disabled,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      onClick={async () => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {busy ? "Working…" : armed ? confirmLabel : label}
    </button>
  );
}

export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return useMemo(() => debounced, [debounced]);
}
