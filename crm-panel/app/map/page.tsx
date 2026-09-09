"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  geoOrthographic,
  geoEquirectangular,
  geoPath,
  geoGraticule10,
  geoDistance,
} from "d3-geo";
import { feature } from "topojson-client";
import { Globe2, Map as MapIcon, Radio, Loader2, Activity } from "lucide-react";

type Point = {
  event: string;
  lat: number;
  lon: number;
  city: string | null;
  region: string | null;
  country: string | null;
  hostname: string | null;
  source: string | null;
  campaign: string | null;
  identified: boolean;
  at: string;
};

const WINDOWS = [
  { label: "1h", min: 60 },
  { label: "24h", min: 1440 },
  { label: "7 dias", min: 10080 },
];

type FunnelStage = { event: string; label: string; visitantes: number; eventos: number };

/** Cor por etapa do funil, na mesma paleta do restante do painel. */
function funnelStageColor(event: string): string {
  if (event === "purchase") return "#10b981";
  if (event === "pix_generated") return "#f59e0b";
  if (event === "initiate_checkout") return "#f59e0b";
  return "#38bdf8";
}

/** Verde = venda, dourado = lead identificado, azul = visita. */
function pointColor(p: Point): string {
  if (p.event === "purchase") return "#10b981";
  if (
    p.identified ||
    ["generate_lead", "initiate_checkout", "begin_checkout", "add_payment_info"].includes(p.event)
  )
    return "#f59e0b";
  return "#38bdf8";
}

/** Le o produto escolhido no seletor global da sidebar (cookie, client-side). */
function produtoDaSidebar(): string {
  const m = document.cookie.match(/(?:^|; )tracking_produto=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function parseAt(at: string): number {
  const t = Date.parse(at.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? 0 : t;
}

export default function LiveMapPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"globe" | "flat">("globe");
  const [win, setWin] = useState(1440);
  const [points, setPoints] = useState<Point[]>([]);
  const [land, setLand] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number>(0);
  const [funnel, setFunnel] = useState<FunnelStage[]>([]);
  const [funnelTotal, setFunnelTotal] = useState(0);
  const [funnelWin, setFunnelWin] = useState(15);

  // Refs usados dentro do loop de animacao (sempre a versao mais recente).
  const pointsRef = useRef<Point[]>([]);
  // So os N mais recentes ganham rotulo de cidade — todo ponto rotulado vira
  // poluicao visual com centenas deles na tela.
  const labeledRef = useRef<Set<Point>>(new Set());
  const modeRef = useRef(mode);
  const landRef = useRef<any>(null);
  const rotation = useRef<[number, number]>([-50, -15]);
  const drag = useRef<{ x: number; y: number; l: number; p: number } | null>(null);
  const autoSpin = useRef(true);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  /* -------------------- carrega o mapa-mundi uma vez -------------------- */
  useEffect(() => {
    let alive = true;
    fetch("/countries-110m.json")
      .then((r) => r.json())
      .then((topo) => {
        if (!alive) return;
        const geo = feature(topo, topo.objects.countries);
        landRef.current = geo;
        setLand(geo);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /* ------------------------- polling dos pontos ------------------------ */
  useEffect(() => {
    let alive = true;
    let timer: any;

    async function tick() {
      try {
        const produto = produtoDaSidebar();
        const qs = produto ? `&produto=${encodeURIComponent(produto)}` : "";
        const res = await fetch(`/api/geo?sinceMin=${win}&limit=800${qs}`, { cache: "no-store" });
        const data = await res.json();
        if (!alive) return;
        setError(data.error || null);
        const pts: Point[] = data.points || [];
        setPoints(pts);
        pointsRef.current = pts;
        labeledRef.current = new Set(
          [...pts].sort((a, b) => parseAt(b.at) - parseAt(a.at)).slice(0, 8)
        );
        setUpdatedAt(Date.now());
      } catch (err: any) {
        if (alive) setError(err.message);
      } finally {
        if (alive) {
          setLoading(false);
          timer = setTimeout(tick, 5000);
        }
      }
    }
    setLoading(true);
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [win]);

  /* --------------------- polling do funil ao vivo ----------------------- */
  useEffect(() => {
    let alive = true;
    let timer: any;

    async function tick() {
      try {
        const produto = produtoDaSidebar();
        const qs = produto ? `&produto=${encodeURIComponent(produto)}` : "";
        const res = await fetch(`/api/live-funnel?sinceMin=${funnelWin}${qs}`, { cache: "no-store" });
        const data = await res.json();
        if (!alive) return;
        setFunnel(data.stages || []);
        setFunnelTotal(data.totalAoVivo || 0);
      } catch {
        // silencioso — o painel de erro do mapa ja cobre falhas de API
      } finally {
        if (alive) timer = setTimeout(tick, 8000);
      }
    }
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [funnelWin]);

  /* --------------------------- desenho (RAF) --------------------------- */
  useEffect(() => {
    let raf = 0;
    let running = true;

    function draw(now: number) {
      if (!running) return;
      const canvas = canvasRef.current;
      const ctx = canvas ? canvas.getContext("2d") : null;
      if (!canvas || !ctx) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const parent = canvas.parentElement;
      const w = parent ? parent.clientWidth : 640;
      const h = 680;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const isGlobe = modeRef.current === "globe";
      if (isGlobe && autoSpin.current && !drag.current) {
        rotation.current[0] += 0.12;
      }

      const projection = isGlobe
        ? geoOrthographic()
            .rotate([rotation.current[0], rotation.current[1]])
            .clipAngle(90)
            .fitExtent(
              [
                [24, 24],
                [w - 24, h - 24],
              ],
              { type: "Sphere" } as any
            )
        : geoEquirectangular().fitExtent(
            [
              [8, 8],
              [w - 8, h - 8],
            ],
            { type: "Sphere" } as any
          );

      const path = geoPath(projection as any, ctx);
      const sphereXY = projection([0, isGlobe ? rotation.current[1] * -1 : 0] as any);

      // Fundo da tela: gradiente radial suave, mais parecido com GA4/Shopify
      // do que um preto chapado.
      const bgGrad = ctx.createRadialGradient(w / 2, h * 0.42, h * 0.1, w / 2, h * 0.5, h * 0.75);
      bgGrad.addColorStop(0, "#0f1b30");
      bgGrad.addColorStop(1, "#060a14");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // Halo atras do globo/mapa — o "atmosphere glow" que da profundidade.
      if (sphereXY) {
        const [cx, cy] = sphereXY;
        const haloR = isGlobe ? Math.min(w, h) * 0.42 : Math.min(w, h) * 0.55;
        const halo = ctx.createRadialGradient(cx, cy, haloR * 0.7, cx, cy, haloR * 1.35);
        halo.addColorStop(0, "rgba(56,189,248,0.16)");
        halo.addColorStop(1, "rgba(56,189,248,0)");
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(cx, cy, haloR * 1.35, 0, Math.PI * 2);
        ctx.fill();
      }

      // Oceano / fundo da esfera
      const oceanGrad = isGlobe && sphereXY
        ? (() => {
            const [cx, cy] = sphereXY;
            const r = Math.min(w, h) * 0.42;
            const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r * 1.05);
            g.addColorStop(0, "#132540");
            g.addColorStop(1, "#0a1526");
            return g;
          })()
        : "#0d1a2e";
      ctx.beginPath();
      path({ type: "Sphere" } as any);
      ctx.fillStyle = oceanGrad as any;
      ctx.fill();
      ctx.strokeStyle = "rgba(56,189,248,0.3)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Meridianos/paralelos
      ctx.beginPath();
      path(geoGraticule10());
      ctx.strokeStyle = "rgba(148,163,184,0.08)";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Continentes
      if (landRef.current) {
        ctx.beginPath();
        path(landRef.current);
        ctx.fillStyle = "#25446b";
        ctx.fill();
        ctx.strokeStyle = "rgba(148,197,253,0.35)";
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }

      // Centro visivel do globo (para esconder pontos no lado de tras)
      const center: [number, number] = [-rotation.current[0], -rotation.current[1]];
      const pts = pointsRef.current;
      // Rotulos de cidade desenhados por cima de todos os pontos, no final —
      // senao um ponto pintado depois cobre o texto do ponto anterior.
      const labels: { x: number; y: number; text: string; color: string }[] = [];

      for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        if (isGlobe && geoDistance([p.lon, p.lat], center) > Math.PI / 2) continue;
        const xy = projection([p.lon, p.lat] as any);
        if (!xy) continue;
        const [x, y] = xy;
        const color = pointColor(p);
        const age = now - (p as any)._seen0;

        if (labeledRef.current.has(p)) {
          const text = [p.city, p.region || p.country].filter(Boolean).join(", ");
          if (text) labels.push({ x, y, text, color });
        }

        // Anel pulsante nos pontos recentes (entraram ha < 6s).
        const fresh = Date.now() - parseAt(p.at) < 6000;
        if (fresh) {
          const t = (now % 1600) / 1600;
          ctx.beginPath();
          ctx.arc(x, y, 3 + t * 18, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.globalAlpha = (1 - t) * 0.9;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // Halo suave por baixo do ponto, mais largo que o brilho da sombra —
        // e o que da o efeito "farol" do GA4/Shopify em vez de um pixel seco.
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;

        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        void age;
      }

      // Rotulos de cidade dos pontos mais recentes, com um "pill" de fundo
      // para ficar legivel em cima de continente ou oceano.
      ctx.font = "600 11px system-ui, -apple-system, sans-serif";
      ctx.textBaseline = "middle";
      for (const l of labels) {
        const textW = ctx.measureText(l.text).width;
        const padX = 6;
        const boxW = textW + padX * 2;
        const boxH = 18;
        const bx = l.x + 8;
        const by = l.y - boxH / 2;

        ctx.beginPath();
        ctx.roundRect?.(bx, by, boxW, boxH, 5);
        if (!ctx.roundRect) ctx.rect(bx, by, boxW, boxH);
        ctx.fillStyle = "rgba(6,10,20,0.72)";
        ctx.fill();
        ctx.strokeStyle = "rgba(148,197,253,0.25)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(bx + padX - 2, l.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = l.color;
        ctx.fill();

        ctx.fillStyle = "#e2e8f0";
        ctx.fillText(l.text, bx + padX + 4, l.y + 0.5);
      }

      raf = requestAnimationFrame(draw);
    }

    // Primeiro frame sincrono: pinta na hora, sem depender do rAF (que o
    // navegador pausa em aba oculta). Os frames seguintes seguem pelo rAF.
    draw(0);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  /* ----------------------- arrastar para girar ------------------------ */
  function onPointerDown(e: React.PointerEvent) {
    if (mode !== "globe") return;
    autoSpin.current = false;
    drag.current = { x: e.clientX, y: e.clientY, l: rotation.current[0], p: rotation.current[1] };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    rotation.current[0] = drag.current.l + dx * 0.4;
    rotation.current[1] = Math.max(-89, Math.min(89, drag.current.p - dy * 0.4));
  }
  function onPointerUp() {
    drag.current = null;
    setTimeout(() => (autoSpin.current = true), 2500);
  }

  /* --------------------------- agregados ------------------------------ */
  const stats = useMemo(() => {
    const now = Date.now();
    const live = points.filter((p) => now - parseAt(p.at) < 5 * 60 * 1000).length;
    const leads = points.filter(
      (p) => p.identified || p.event === "generate_lead" || p.event === "purchase"
    ).length;
    const byCountry = new Map<string, number>();
    for (const p of points) {
      const k = p.country || "??";
      byCountry.set(k, (byCountry.get(k) || 0) + 1);
    }
    const topCountries = Array.from(byCountry.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { live, leads, topCountries };
  }, [points]);

  const recent = useMemo(
    () => [...points].sort((a, b) => parseAt(b.at) - parseAt(a.at)).slice(0, 40),
    [points]
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
        <Radio size={26} style={{ color: "var(--primary)" }} />
        <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>Ao Vivo</h1>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: "0.72rem",
            color: "var(--success)",
            marginLeft: 4,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--success)",
              boxShadow: "0 0 8px var(--success)",
              display: "inline-block",
            }}
          />
          atualiza a cada 5s
        </span>
      </div>
      <p style={{ color: "var(--text-muted)", marginBottom: "1.25rem", fontSize: "0.85rem" }}>
        Visitantes e leads geolocalizados por IP (via Cloudflare). Arraste o globo para girar.
      </p>

      {/* Controles */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 4, background: "var(--surface)", padding: 4, borderRadius: 8, border: "1px solid var(--border)" }}>
          <button
            className="btn"
            onClick={() => setMode("globe")}
            style={{ background: mode === "globe" ? "var(--primary)" : "transparent", color: mode === "globe" ? "#fff" : "var(--text-muted)", padding: "0.4rem 0.8rem" }}
          >
            <Globe2 size={16} /> Globo 3D
          </button>
          <button
            className="btn"
            onClick={() => setMode("flat")}
            style={{ background: mode === "flat" ? "var(--primary)" : "transparent", color: mode === "flat" ? "#fff" : "var(--text-muted)", padding: "0.4rem 0.8rem" }}
          >
            <MapIcon size={16} /> Mapa 2D
          </button>
        </div>

        <div style={{ display: "flex", gap: 4, background: "var(--surface)", padding: 4, borderRadius: 8, border: "1px solid var(--border)" }}>
          {WINDOWS.map((wns) => (
            <button
              key={wns.min}
              className="btn"
              onClick={() => setWin(wns.min)}
              style={{ background: win === wns.min ? "var(--surface-hover)" : "transparent", color: win === wns.min ? "var(--text-main)" : "var(--text-muted)", padding: "0.4rem 0.8rem" }}
            >
              {wns.label}
            </button>
          ))}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: "1.25rem", alignItems: "center", fontSize: "0.8rem" }}>
          <Legend color="#38bdf8" label="Visita" />
          <Legend color="#f59e0b" label="Lead" />
          <Legend color="#10b981" label="Venda" />
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: "var(--warning)", marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.85rem", color: "var(--warning)" }}>{error}</div>
        </div>
      )}

      {/* Funil ao vivo */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.9rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Activity size={18} style={{ color: "var(--primary)" }} />
            <h2 style={{ fontSize: "1.05rem", fontWeight: 600 }}>Funil ao vivo</h2>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              — {funnelTotal.toLocaleString("pt-BR")} pessoa{funnelTotal === 1 ? "" : "s"} ativa{funnelTotal === 1 ? "" : "s"} nos últimos {funnelWin} min
            </span>
          </div>
          <div style={{ display: "flex", gap: 4, background: "var(--surface)", padding: 4, borderRadius: 8, border: "1px solid var(--border)" }}>
            {[5, 15, 30, 60].map((m) => (
              <button
                key={m}
                className="btn"
                onClick={() => setFunnelWin(m)}
                style={{
                  background: funnelWin === m ? "var(--surface-hover)" : "transparent",
                  color: funnelWin === m ? "var(--text-main)" : "var(--text-muted)",
                  padding: "0.3rem 0.65rem",
                  fontSize: "0.75rem",
                }}
              >
                {m}min
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: `repeat(${funnel.length || 4}, 1fr)`, gap: "0.75rem" }}>
          {funnel.map((s, i) => {
            const prevN = i > 0 ? funnel[i - 1].visitantes : s.visitantes;
            const pct = prevN > 0 ? Math.round((s.visitantes / prevN) * 100) : 0;
            return (
              <div
                key={s.event}
                className="checklist-item"
                style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0.85rem 1rem" }}
              >
                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                  {s.label}
                </div>
                <div style={{ fontSize: "1.6rem", fontWeight: 700, color: funnelStageColor(s.event) }}>
                  {s.visitantes.toLocaleString("pt-BR")}
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-faint, var(--text-muted))" }}>
                  {i === 0 ? `${s.eventos} evento${s.eventos === 1 ? "" : "s"}` : `${pct}% da etapa anterior`}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "1.5rem", alignItems: "start" }}>
        {/* Mapa */}
        <div className="card" style={{ padding: 0, overflow: "hidden", position: "relative" }}>
          {loading && (
            <div style={{ position: "absolute", top: 12, right: 12, color: "var(--text-muted)", zIndex: 2 }}>
              <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
            </div>
          )}
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{ width: "100%", height: 680, display: "block", cursor: mode === "globe" ? "grab" : "default", touchAction: "none" }}
          />
          <div style={{ position: "absolute", left: 16, bottom: 14, display: "flex", gap: "1.5rem" }}>
            <Stat big label="visitantes (5 min)" value={stats.live} color="var(--primary)" />
            <Stat big label="leads/vendas" value={stats.leads} color="#f59e0b" />
            <Stat big label="pontos" value={points.length} color="var(--text-muted)" />
          </div>
        </div>

        {/* Painel lateral */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          <div className="table-container">
            <div className="table-header"><h2>Top países</h2></div>
            <div style={{ padding: "0.75rem 1rem" }}>
              {stats.topCountries.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", padding: "0.5rem 0" }}>Sem dados na janela.</div>
              ) : (
                stats.topCountries.map(([c, n]) => (
                  <div key={c} style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0", fontSize: "0.85rem" }}>
                    <span>{flag(c)} {c}</span>
                    <span style={{ color: "var(--text-muted)" }}>{n}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="table-container">
            <div className="table-header"><h2>Chegando agora</h2></div>
            <div style={{ maxHeight: 360, overflowY: "auto" }}>
              {recent.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", padding: "1rem" }}>
                  Nenhum acesso geolocalizado ainda. Assim que o Worker atualizado receber visitas, os pontos aparecem aqui.
                </div>
              ) : (
                recent.map((p, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "0.5rem 1rem", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: pointColor(p), boxShadow: `0 0 6px ${pointColor(p)}`, flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: "0.82rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {[p.city, p.region, p.country].filter(Boolean).join(", ") || "Local desconhecido"}
                      </div>
                      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                        {p.source || "direto"}{p.hostname ? ` · ${p.hostname}` : ""}
                      </div>
                    </div>
                    <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", flexShrink: 0 }}>{ago(p.at)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />
      {label}
    </span>
  );
}

function Stat({ label, value, color, big }: { label: string; value: number; color: string; big?: boolean }) {
  return (
    <div style={{ background: "rgba(2,6,23,0.55)", backdropFilter: "blur(4px)", padding: "0.5rem 0.85rem", borderRadius: 8, border: "1px solid var(--border)" }}>
      <div style={{ fontSize: big ? "1.35rem" : "1rem", fontWeight: 700, color }}>{value.toLocaleString("pt-BR")}</div>
      <div style={{ fontSize: "0.66rem", color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}

/** Bandeira emoji a partir do código ISO de país (BR -> 🇧🇷). */
function flag(cc: string): string {
  if (!cc || cc.length !== 2 || cc === "??") return "🏳️";
  const base = 127397;
  return String.fromCodePoint(...cc.toUpperCase().split("").map((c) => base + c.charCodeAt(0)));
}

function ago(at: string): string {
  const s = Math.max(0, Math.floor((Date.now() - parseAt(at)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
