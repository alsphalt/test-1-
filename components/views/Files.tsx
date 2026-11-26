"use client";

import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { ConfirmButton, SectionEmpty, fmtBytes, ago, useToast } from "../ui";
import type { FileRow } from "../types";

type FileListResponse = { files: FileRow[]; usedBytes: number; quotaBytes: number };

export default function Files({ tick }: { tick: number }) {
  const [data, setData] = useState<FileListResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  const toast = useToast();

  const load = () => {
    api
      .get<FileListResponse>("/api/files")
      .then(setData)
      .catch((err) => setError(errorMessage(err)));
  };

  useEffect(load, [tick]);

  const upload = async (files: globalThis.FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError("");
    let done = 0;
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      try {
        await api.post("/api/files", form);
        done += 1;
      } catch (err) {
        setError(`${file.name}: ${errorMessage(err)}`);
      }
    }
    setBusy(false);
    if (done) toast(`${done} file${done > 1 ? "s" : ""} uploaded`, "ok");
    load();
    if (input.current) input.current.value = "";
  };

  const remove = async (id: string) => {
    try {
      await api.del(`/api/files/${id}`);
      toast("File deleted", "ok");
      load();
    } catch (err) {
      toast(errorMessage(err), "err");
    }
  };

  const used = data?.usedBytes || 0;
  const quota = data?.quotaBytes || 1;
  const pct = Math.min(100, Math.round((used / quota) * 100));

  return (
    <>
      <div className="page-h">
        <div>
          <h2>
            FILE <em>MANAGER</em>
          </h2>
          <p>Bytes are stored in the database and only readable by your account. 4 MB per file, 50 MB per account.</p>
        </div>
        <button className="btn p" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? "Uploading…" : "+ Upload"}
        </button>
      </div>

      <div className="panel">
        <div className="pn-bar">
          <span>
            Storage <em className="pn-st ready">{fmtBytes(used)} / {fmtBytes(quota)}</em>
          </span>
          <span style={{ fontSize: 12, color: "#8d8d97" }}>{data?.files.length || 0} files</span>
        </div>
        <div className="bar" style={{ marginBottom: 14 }}>
          <i style={{ width: `${pct}%` }} />
        </div>

        <div
          className={`drop ${over ? "over" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") input.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void upload(e.dataTransfer.files);
          }}
        >
          <b>Drop files here</b>
          or click to browse · max 4 MB each
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
          aria-label="Upload files"
        />

        {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}

        <div style={{ marginTop: 16 }}>
          {!data ? (
            <div className="empty-state">Loading files…</div>
          ) : data.files.length === 0 ? (
            <SectionEmpty>No files yet. Anything you upload stays available after refresh and logout.</SectionEmpty>
          ) : (
            <div className="rows">
              {data.files.map((f) => (
                <div className="row" key={f.id}>
                  <div className="grow">
                    <b>{f.name}</b>
                    <small>
                      {fmtBytes(f.size)} · {f.mimeType || "unknown type"} · {ago(f.createdAt)}
                    </small>
                  </div>
                  <div className="btns">
                    <a className="btn sm" href={`/api/files/${f.id}`} download>
                      Download
                    </a>
                    <ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={() => remove(f.id)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
