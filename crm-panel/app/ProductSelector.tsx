"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Boxes, ChevronDown } from "lucide-react";

type ProdutoOption = { product: string; containerId: string | null };

/**
 * Filtra o painel inteiro (Eventos, Compras, Leads, Conversões) por um
 * produto especifico — util quando cada produto tem propriedade GA4 e
 * container GTM proprios e voce quer ver so os dados dele.
 */
export default function ProductSelector() {
  const router = useRouter();
  const [produtos, setProdutos] = useState<ProdutoOption[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/product-filter");
      if (!res.ok) return;
      const data = await res.json();
      setProdutos(data.produtos || []);
      setSelected(data.selected || "");
    } catch {
      /* painel funciona sem esse filtro */
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function apply(product: string) {
    setBusy(true);
    try {
      await fetch("/api/product-filter", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product }),
      });
      setSelected(product);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (produtos.length === 0) return null;

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
        <Boxes size={13} />
        Produto
      </label>
      <div style={{ position: "relative" }}>
        <select
          value={selected}
          disabled={busy}
          onChange={(e) => apply(e.target.value)}
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
          <option value="">Todos os produtos</option>
          {produtos.map((p) => (
            <option key={p.product} value={p.product}>
              {p.product} {p.containerId ? `— ${p.containerId}` : ""}
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
