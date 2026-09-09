"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, ChevronDown } from "lucide-react";

type ProfileOption = { id: string; name: string; state?: any };

/** Troca o cliente ativo. Todas as telas passam a mostrar os dados dele. */
export default function ProfileSwitcher() {
  const router = useRouter();
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [active, setActive] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/profiles");
      if (!res.ok) return;
      const data = await res.json();
      setProfiles(data.profiles || []);
      setActive(data.activeProfile || "");
    } catch {
      /* painel funciona sem perfis */
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function switchTo(id: string) {
    if (!id || id === active) return;
    setBusy(true);
    try {
      await fetch("/api/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setActive(id);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (profiles.length === 0) {
    return (
      <div style={{ padding: "0 1rem 1rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
        Nenhum cliente cadastrado ainda.
      </div>
    );
  }

  return (
    <div style={{ padding: "0 0.5rem 1rem" }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-muted)",
          padding: "0 0.5rem 0.4rem",
        }}
      >
        <Building2 size={13} />
        Cliente
      </label>
      <div style={{ position: "relative" }}>
        <select
          value={active}
          disabled={busy}
          onChange={(e) => switchTo(e.target.value)}
          style={{
            width: "100%",
            appearance: "none",
            padding: "0.6rem 2rem 0.6rem 0.75rem",
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: "0.5rem",
            color: "var(--text-main)",
            fontSize: "0.85rem",
            fontFamily: "inherit",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.id}
            </option>
          ))}
        </select>
        <ChevronDown
          size={15}
          style={{
            position: "absolute",
            right: "0.65rem",
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
            color: "var(--text-muted)",
          }}
        />
      </div>
    </div>
  );
}
