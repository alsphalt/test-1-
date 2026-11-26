"use client";

import { useEffect, useRef, useState } from "react";

const WORD = "DARKNOTE";
const ACCENT_FROM = 4;

/** Snow field — lightweight, pauses when the tab is hidden. */
function Snow() {
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

    type Flake = { x: number; y: number; r: number; vy: number; vx: number; a: number };
    let flakes: Flake[] = [];

    const seed = () => {
      const count = Math.min(140, Math.round((width * height) / 14000));
      flakes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.7 + 0.4,
        vy: Math.random() * 0.45 + 0.15,
        vx: Math.random() * 0.3 - 0.15,
        a: Math.random() * 0.5 + 0.25,
      }));
    };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (const f of flakes) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,255,255,${f.a})`;
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
        if (!reduce) {
          f.y += f.vy;
          f.x += f.vx;
          if (f.y > height + 4) {
            f.y = -4;
            f.x = Math.random() * width;
          }
          if (f.x < -4) f.x = width + 4;
          if (f.x > width + 4) f.x = -4;
        }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas id="dn-snow" ref={ref} aria-hidden="true" />;
}

function Lights() {
  const bulbs = Array.from({ length: 28 }, (_, i) => i);
  return (
    <div id="dn-lights" aria-hidden="true">
      <svg viewBox="0 0 100 12" preserveAspectRatio="none">
        <path d="M0 3 C 12 12, 24 12, 36 3 S 60 12, 72 3 S 88 12, 100 3" fill="none" stroke="#23252e" strokeWidth="0.6" />
      </svg>
      {bulbs.map((i) => {
        const left = (i / (bulbs.length - 1)) * 100;
        const color = i % 3 === 0 ? "#ff2e4d" : i % 3 === 1 ? "#ffd36a" : "#22d36b";
        return (
          <span
            key={i}
            className="bulb"
            style={
              {
                left: `${left}%`,
                top: `${6 + Math.abs(Math.sin((i / bulbs.length) * Math.PI * 3)) * 12}px`,
                background: color,
                "--c": color,
                animationDelay: `${i * 0.045}s, ${(i % 7) * 0.18}s`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

export default function Intro({ onEnter }: { onEnter: () => void }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    document.body.classList.add("locked");
    const id = setTimeout(() => setReady(true), 4300);
    return () => {
      clearTimeout(id);
      document.body.classList.remove("locked");
    };
  }, []);

  return (
    <div
      id="dn-intro"
      className={`play ${ready ? "ready" : ""}`}
      onClick={() => {
        if (ready) onEnter();
      }}
    >
      <Snow />
      <Lights />

      <div className="stage">
        <svg className="mark" viewBox="0 0 100 120" role="img" aria-label="Darknote Nexus">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#ff2e4d" />
              <stop offset="60%" stopColor="#ff7ac8" />
              <stop offset="100%" stopColor="#ffd36a" />
            </linearGradient>
          </defs>

          {/* christmas tree built from three strokes + trunk */}
          <path className="draw" pathLength={1} d="M50 18 L70 46 L58 46 L76 70 L62 70 L80 92 L20 92 L38 70 L24 70 L42 46 L30 46 Z" />
          <path className="draw" pathLength={1} d="M50 92 L50 110" />

          {/* hat */}
          <g className="hat">
            <path d="M50 18 L44 2 Q50 0 56 3 Z" fill="#ff2e4d" />
            <circle className="pom" cx="50" cy="2" r="4" fill="#fff3c4" />
          </g>

          {/* sparkles */}
          <g fill="#ffd36a">
            <path className="spark" d="M14 34 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z" />
            <path className="spark" style={{ animationDelay: "2.9s" }} d="M86 52 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6 z" />
            <path className="spark" style={{ animationDelay: "3.4s" }} d="M22 74 l1.4 3.4 3.4 1.4 -3.4 1.4 -1.4 3.4 -1.4 -3.4 -3.4 -1.4 3.4 -1.4 z" />
          </g>
        </svg>

        <h1 className="word">
          {WORD.split("").map((letter, i) => (
            <span key={`${letter}-${i}`} className={i >= ACCENT_FROM ? "acc" : ""} style={{ "--i": i } as React.CSSProperties}>
              {letter}
            </span>
          ))}
        </h1>

        <div className="xmas">Nexus</div>
        <div className="sub">Secure command layer</div>
      </div>

      <div className="intro-cta">
        <button type="button" onClick={onEnter}>
          {ready ? "Enter" : "Loading…"}
        </button>
      </div>

      <div className="powered">
        Powered by <b>Darknote</b> Systems
      </div>
    </div>
  );
}
