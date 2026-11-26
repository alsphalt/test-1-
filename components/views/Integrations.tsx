"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { ConfirmButton, Modal, Pill, SectionEmpty, ago, useToast } from "../ui";
import type { Integration } from "../types";

type TestResult = { ok: boolean; status: number; latency: number; snippet: string; error: string };

export default function Integrations({ tick }: { tick: number }) {
  const [rows, setRows] = useState<Integration[]>([]);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const toast = useToast();

  const load = () => {
    api
      .get<{ integrations: Integration[] }>("/api/integrations")
      .then((res) => setRows(res.integrations))
      .catch((err) => toast(errorMessage(err), "err"));
  };

  useEffect(load, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      await api.post("/api/integrations", {
        provider: provider.trim(),
        baseUrl: baseUrl.trim(),
        headerName: headerName.trim() || "Authorization",
        apiKey,
      });
      setOpen(false);
      setProvider("");
      setBaseUrl("");
      setApiKey("");
      setHeaderName("Authorization");
      toast("Integration saved — the key is encrypted at rest.", "ok");
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async (row: Integration) => {
    setTesting(row.id);
    try {
      const res = await api.post<TestResult>(`/api/integrations/${row.id}/test`);
      setResults((prev) => ({ ...prev, [row.id]: res }));
      toast(res.ok ? `Reachable (${res.status} in ${res.latency}ms)` : `Failed${res.status ? ` (HTTP ${res.status})` : ""}`, res.ok ? "ok" : "err");
      load();
    } catch (err) {
      toast(errorMessage(err), "err");
    } finally {
      setTesting(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.del(`/api/integrations/${id}`);
      toast("Integration removed", "ok");
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
            API <em>INTEGRATIONS</em>
          </h2>
          <p>Keys are encrypted with AES-256-GCM before they touch the database and never returned to the browser.</p>
        </div>
        <button className="btn p" onClick={() => setOpen(true)}>
          + Connect API
        </button>
      </div>

      <section className="panel">
        <h4>
          Connections <em>{rows.length}</em>
        </h4>

        {rows.length === 0 ? (
          <SectionEmpty>
            Nothing connected yet. Add an endpoint and key, then run a live test — the request is made from the server.
          </SectionEmpty>
        ) : (
          <div className="rows">
            {rows.map((row) => {
              const result = results[row.id];
              return (
                <div className="row" key={row.id} style={{ flexWrap: "wrap" }}>
                  <div className="grow">
                    <b>{row.provider}</b>
                    <small>
                      {row.baseUrl} · key {row.keyPrefix} · tested {ago(row.lastTestAt)}
                    </small>
                    {result && (
                      <small style={{ color: result.ok ? "#5cffb0" : "#ff8fa3", marginTop: 4 }}>
                        {result.ok ? `HTTP ${result.status} in ${result.latency}ms` : result.error || `HTTP ${result.status}`}
                        {result.snippet ? ` · ${result.snippet.slice(0, 90)}` : ""}
                      </small>
                    )}
                  </div>
                  <Pill value={row.status} />
                  <div className="btns">
                    <button className="btn sm g" onClick={() => test(row)} disabled={testing === row.id}>
                      {testing === row.id ? "Testing…" : "Test"}
                    </button>
                    <ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={() => remove(row.id)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {open && (
        <Modal
          title="Connect an API"
          subtitle="The server calls this URL with your header when you press Test. Private and loopback addresses are blocked."
          onClose={() => setOpen(false)}
        >
          <div className="form">
            <div>
              <label htmlFor="in-provider">Provider name</label>
              <input id="in-provider" value={provider} maxLength={40} placeholder="Stripe" onChange={(e) => setProvider(e.target.value)} />
            </div>
            <div>
              <label htmlFor="in-url">Health / endpoint URL</label>
              <input
                id="in-url"
                value={baseUrl}
                placeholder="https://api.stripe.com/v1/charges?limit=1"
                onChange={(e) => setBaseUrl(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="two">
              <div>
                <label htmlFor="in-header">Header</label>
                <input id="in-header" value={headerName} maxLength={40} onChange={(e) => setHeaderName(e.target.value)} />
              </div>
              <div>
                <label htmlFor="in-key">API key</label>
                <input
                  id="in-key"
                  type="password"
                  value={apiKey}
                  placeholder="sk_live_…"
                  onChange={(e) => setApiKey(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="hint">For bearer keys leave the header as <code>Authorization</code> and paste the full value.</div>
            {error && <div className="err">{error}</div>}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn p" onClick={create} disabled={busy || !provider.trim() || !baseUrl.trim() || apiKey.length < 8}>
              {busy ? "Saving…" : "Save integration"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
