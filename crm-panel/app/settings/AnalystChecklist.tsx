"use client";

import { CheckCircle2, AlertTriangle, Circle, ClipboardCheck } from "lucide-react";

type ItemStatus = "ok" | "warn" | "pending";

type Item = {
  status: ItemStatus;
  title: string;
  desc: string;
};

const ICON: Record<ItemStatus, JSX.Element> = {
  ok: <CheckCircle2 size={13} />,
  warn: <AlertTriangle size={13} />,
  pending: <Circle size={13} />,
};

/**
 * Checklist do analista: os itens que /configuracao-gtm-ga4 define como
 * necessários para uma integração GTM + GA4 + servidor considerada completa —
 * mapeados para o estado real do perfil (não é um formulário, é um raio-x).
 */
export default function AnalystChecklist({
  state,
  formData,
  secretsSaved,
  health,
}: {
  state: any;
  formData: any;
  secretsSaved: Record<string, boolean>;
  health: any;
}) {
  const purchasesReceived = Number(health?.database?.purchases || 0) > 0;

  const items: Item[] = [
    {
      status: state?.containerId ? "ok" : "pending",
      title: "Container Web criado no GTM",
      desc: state?.containerId
        ? `Ativo: ${state.containerId}`
        : "Preencha os campos abaixo e rode o setup para criar.",
    },
    {
      status: formData?.ga4MeasurementId ? "ok" : "pending",
      title: "GA4 configurado (Measurement ID)",
      desc: formData?.ga4MeasurementId || "Sem Measurement ID — obrigatório para qualquer evento chegar ao GA4.",
    },
    {
      status: state?.containerId ? "ok" : "pending",
      title: "Variáveis e acionadores no container",
      desc: "GCLID/GBRAID/WBRAID, UTMs, cookies (_fbc/_fbp/_tsid) e acionadores de ecommerce — criados e organizados em pastas automaticamente pelo setup.",
    },
    {
      status: secretsSaved?.ga4ApiSecret ? "ok" : "warn",
      title: "Envio server-side ativo (Measurement Protocol)",
      desc: secretsSaved?.ga4ApiSecret
        ? "Segredo configurado — vendas do webhook chegam ao GA4 mesmo sem navegador."
        : "Sem o segredo do Measurement Protocol, vendas via webhook (pix, compra) não aparecem no GA4.",
    },
    {
      status: state?.smokeTestOk ? "ok" : "pending",
      title: "Teste ponta a ponta (smoke test)",
      desc: state?.smokeTestOk
        ? "O último setup confirmou: evento sintético percorreu Worker → D1 com sucesso."
        : "Ainda não confirmado. Rode o setup para validar o caminho completo.",
    },
    {
      status: purchasesReceived ? "ok" : "pending",
      title: "Webhooks recebendo vendas de verdade",
      desc: purchasesReceived
        ? `${health.database.purchases} venda(s) já gravada(s) no banco.`
        : "Nenhuma venda recebida ainda — confirme que a plataforma aponta para o endpoint de webhook.",
    },
    {
      status: state?.customDomain ? "ok" : "warn",
      title: "Domínio próprio (cookies first-party)",
      desc: state?.customDomain
        ? `Ativo: ${state.customDomain}`
        : "Recomendado, não obrigatório. Sem domínio próprio, *.workers.dev é bloqueado por parte dos navegadores/adblockers.",
    },
    {
      status: state?.metaEnabled || state?.googleAdsEnabled ? "ok" : "warn",
      title: "Conversões voltando para o anúncio",
      desc:
        state?.metaEnabled || state?.googleAdsEnabled
          ? [state?.metaEnabled && "Meta CAPI", state?.googleAdsEnabled && "Google Ads offline"].filter(Boolean).join(" + ") + " ativo(s)."
          : "Sem isso o rastreamento só guarda dado — o algoritmo do anúncio não aprende com a venda aprovada.",
    },
  ];

  const okCount = items.filter((i) => i.status === "ok").length;

  return (
    <div className="table-container" style={{ marginBottom: "2rem" }}>
      <div className="table-header">
        <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <ClipboardCheck size={17} style={{ color: "var(--primary)" }} />
          Checklist do analista — GTM &amp; GA4
        </h2>
        <span
          className={`badge ${okCount === items.length ? "badge-success" : "badge-warning"}`}
        >
          {okCount}/{items.length} completos
        </span>
      </div>
      <div style={{ padding: "0.25rem 1.5rem" }}>
        {items.map((item) => (
          <div className="checklist-item" key={item.title}>
            <span className={`checklist-icon ${item.status}`}>{ICON[item.status]}</span>
            <div>
              <div className="checklist-title">{item.title}</div>
              <div className="checklist-desc">{item.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
