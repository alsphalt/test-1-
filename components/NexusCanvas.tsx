"use client";

import { useEffect, useRef } from "react";

const GLYPHS = "01ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﬄﬅ◈◇◆×+".split("");

/** Fixed terminal rain behind the dashboard. Cheap, DPR-aware, tab-aware. */
export default function NexusCanvas() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let raf = 0;
    let last = 0;
    let columns: { x: number; y: number; speed: number; size: number; hue: number }[] = [];

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const gap = 34;
      columns = [];
      for (let x = gap / 2; x < width; x += gap) {
        columns.push({
          x,
          y: Math.random() * height,
          speed: 18 + Math.random() * 46,
          size: 12 + Math.random() * 3,
          hue: Math.random() > 0.72 ? 330 : 350,
        });
      }
    };

    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000) || 0;
      last = t;
      ctx.clearRect(0, 0, width, height);
      ctx.font = "13px ui-monospace, Menlo, Consolas, monospace";
      for (const col of columns) {
        const char = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        ctx.fillStyle = `hsla(${col.hue}, 90%, 62%, 0.10)`;
        ctx.font = `${col.size}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.fillText(char, col.x, col.y);
        col.y += col.speed * dt;
        if (col.y > height + 24) {
          col.y = -24;
          col.speed = 18 + Math.random() * 46;
        }
      }
      raf = requestAnimationFrame(frame);
    };

    resize();
    if (reduce) {
      ctx.font = "13px ui-monospace, Menlo, Consolas, monospace";
      for (const col of columns) {
        ctx.fillStyle = "hsla(350, 90%, 62%, 0.07)";
        ctx.fillText(GLYPHS[col.x % GLYPHS.length], col.x, col.y);
      }
    } else {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }

    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else if (!reduce) raf = requestAnimationFrame(frame);
    };

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas id="nx-bg" ref={ref} aria-hidden="true" />;
}
