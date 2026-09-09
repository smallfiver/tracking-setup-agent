"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Play,
  Loader2,
  CheckCircle,
  AlertCircle,
  Settings,
  Save,
  Activity,
  Copy,
  Check,
  Plus,
  Trash2,
} from "lucide-react";
import AnalystChecklist from "./AnalystChecklist";
import ProductTracking from "./ProductTracking";
import GoogleAdsAccounts from "./GoogleAdsAccounts";

type Status = "idle" | "running" | "success" | "error";

/** Precisa bater com o RESULT_MARKER da rota /api/setup. */
const RESULT_MARKER = "\n__SETUP_RESULT__";

const EMPTY = {
  id: "",
  name: "",
  gtmAccountId: "",
  gtmContainerName: "",
  ga4MeasurementId: "",
  cloudflareAccountId: "",
  cloudflareApiToken: "",
  workerName: "",
  trackingDomain: "",
  checkoutDomains: "",
  d1DatabaseName: "",
  trackPageViews: false,
  serviceAccountJson: "",
  setupPassword: "",

  // Recuperação de carrinho abandonado (Cron do Worker)
  abandonedWebhookUrl: "",
  abandonedWebhookToken: "",

  // Etapas do funil — order bump / upsell / downsell
  frontProductIds: "",
  orderBumpProductIds: "",
  upsellProductIds: "",
  downsellProductIds: "",

  // Meta CAPI
  metaPixelId: "",
  metaAccessToken: "",
  metaTestEventCode: "",

  // Google Ads — conversões offline
  googleAdsCustomerId: "",
  googleAdsLoginCustomerId: "",
  googleAdsConversionActionId: "",
  googleAdsDeveloperToken: "",
  googleAdsClientId: "",
  googleAdsClientSecret: "",
  googleAdsRefreshToken: "",
};

export default function SettingsPage() {
  const router = useRouter();

  const [profiles, setProfiles] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [editingId, setEditingId] = useState<string>("");
  const [formData, setFormData] = useState({ ...EMPTY });
  const [secretsSaved, setSecretsSaved] = useState<Record<string, boolean>>({});
  const [serviceAccountSaved, setServiceAccountSaved] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [profilesPath, setProfilesPath] = useState("");
  const [health, setHealth] = useState<any>(null);
  const [produtos, setProdutos] = useState<string[]>([]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [logs, setLogs] = useState("");
  const [copied, setCopied] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const current = profiles.find((p) => p.id === editingId);
  const state = current?.state;

  /* ---------------------- carregar perfis ---------------------- */

  async function loadProfiles(selectId?: string) {
    try {
      const res = await fetch("/api/profiles");
      if (!res.ok) return;
      const data = await res.json();
      setProfiles(data.profiles || []);
      setActiveId(data.activeProfile || "");
      setServiceAccountSaved(data.serviceAccountSaved);
      setPasswordRequired(data.passwordRequired);
      setProfilesPath(data.profilesPath);

      const target = selectId || editingId || data.activeProfile;
      const profile = (data.profiles || []).find((p: any) => p.id === target);
      if (profile) selectProfile(profile);
      else if (!data.profiles?.length) newProfile();
    } catch {
      /* painel funciona sem perfis */
    }
  }

  async function loadHealth() {
    try {
      const res = await fetch("/api/health");
      setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }

  useEffect(() => {
    loadProfiles();
    loadHealth();
    fetch("/api/product-filter")
      .then((r) => r.json())
      .then((d) => setProdutos((d.produtos || []).map((p: any) => p.product)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectProfile(profile: any) {
    setEditingId(profile.id);
    setSecretsSaved(profile.secretsSaved || {});
    setFormData({
      ...EMPTY,
      id: profile.id,
      name: profile.name || "",
      gtmAccountId: profile.gtmAccountId || "",
      gtmContainerName: profile.gtmContainerName || "",
      ga4MeasurementId: profile.ga4MeasurementId || "",
      cloudflareAccountId: profile.cloudflareAccountId || "",
      workerName: profile.workerName || "",
      trackingDomain: profile.trackingDomain || "",
      checkoutDomains: profile.checkoutDomains || "",
      abandonedWebhookUrl: profile.abandonedWebhookUrl || "",
      d1DatabaseName: profile.d1DatabaseName || "",
      trackPageViews: Boolean(profile.trackPageViews),
      frontProductIds: profile.frontProductIds || "",
      orderBumpProductIds: profile.orderBumpProductIds || "",
      upsellProductIds: profile.upsellProductIds || "",
      downsellProductIds: profile.downsellProductIds || "",
      metaPixelId: profile.metaPixelId || "",
      metaTestEventCode: profile.metaTestEventCode || "",
      googleAdsCustomerId: profile.googleAdsCustomerId || "",
      googleAdsLoginCustomerId: profile.googleAdsLoginCustomerId || "",
      googleAdsConversionActionId: profile.googleAdsConversionActionId || "",
      googleAdsClientId: profile.googleAdsClientId || "",
    });
  }

  function newProfile() {
    setEditingId("");
    setSecretsSaved({});
    setFormData({ ...EMPTY });
    setLogs("");
    setStatus("idle");
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const target = e.target as HTMLInputElement;
    const value = target.type === "checkbox" ? target.checked : target.value;
    setFormData((prev) => ({ ...prev, [target.name]: value }));
  };

  /* --------------------------- ações --------------------------- */

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, id: editingId || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus("idle");
        setLogs(`Perfil "${data.profile.name}" salvo em ${profilesPath}.\nVocê pode rodar o setup quando quiser.`);
        setFormData((prev) => ({ ...prev, serviceAccountJson: "" }));
        await loadProfiles(data.id);
        router.refresh();
      } else {
        setStatus("error");
        setLogs("Erro ao salvar: " + data.error);
      }
    } catch (err: any) {
      setStatus("error");
      setLogs("Erro ao salvar: " + err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingId) return;
    if (!confirm(`Remover o perfil "${formData.name}" do painel?\n\nIsso não apaga nada na Cloudflare nem no GTM.`)) return;
    await fetch("/api/profiles", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editingId }),
    });
    newProfile();
    await loadProfiles();
    router.refresh();
  }

  async function handleStartSetup(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setStatus("running");
    setElapsed(0);
    setLogs("Salvando perfil e iniciando o setup...\n");

    const startedAt = Date.now();
    const ticker = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);

    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, id: editingId || undefined }),
      });

      // Erros de validação voltam como JSON, não como stream.
      if (!res.body || res.headers.get("content-type")?.includes("application/json")) {
        const data = await res.json();
        setStatus("error");
        setLogs((prev) => prev + "\n❌ " + (data.error || "Erro desconhecido."));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const marker = buffer.indexOf(RESULT_MARKER);
        setLogs(
          "Salvando perfil e iniciando o setup...\n" + (marker >= 0 ? buffer.slice(0, marker) : buffer)
        );
      }

      const marker = buffer.indexOf(RESULT_MARKER);
      const result = marker >= 0 ? JSON.parse(buffer.slice(marker + RESULT_MARKER.length)) : null;

      if (result?.success) {
        setStatus("success");
        setLogs((prev) => prev + "\n\n✅ Setup concluído. Perfil salvo.");
        setFormData((prev) => ({ ...prev, serviceAccountJson: "" }));
      } else {
        setStatus("error");
        setLogs(
          (prev) => prev + "\n\n❌ O setup terminou com erro. Corrija o ponto acima e rode de novo — nada é duplicado."
        );
      }

      await loadProfiles(result?.profileId);
      await loadHealth();
      router.refresh();
    } catch (err: any) {
      setStatus("error");
      setLogs((prev) => prev + "\n❌ Erro de conexão com a API:\n" + err.message);
    } finally {
      clearInterval(ticker);
      setLoading(false);
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 1500);
  }

  /* --------------------------- render -------------------------- */

  const field = (
    label: string,
    name: keyof typeof EMPTY,
    opts: { placeholder?: string; required?: boolean; hint?: string } = {}
  ) => (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <input
        type="text"
        name={name}
        className="form-input"
        placeholder={opts.placeholder || ""}
        value={formData[name] as string}
        onChange={handleChange}
        required={opts.required}
      />
      {opts.hint && (
        <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>{opts.hint}</div>
      )}
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: "1.5rem", display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <Settings size={28} style={{ color: "var(--primary)" }} />
        <h1 style={{ fontSize: "1.875rem", fontWeight: 700 }}>Configuração</h1>
      </div>

      {/* Abas de clientes */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
        {profiles.map((p) => (
          <button
            key={p.id}
            onClick={() => selectProfile(p)}
            className="btn"
            style={{
              background: editingId === p.id ? "var(--primary)" : "var(--surface)",
              color: editingId === p.id ? "#fff" : "var(--text-muted)",
              border: "1px solid var(--border)",
              padding: "0.5rem 1rem",
            }}
          >
            {p.name || p.id}
            {activeId === p.id && (
              <span style={{ fontSize: "0.65rem", opacity: 0.8 }}>· ativo</span>
            )}
          </button>
        ))}
        <button
          onClick={newProfile}
          className="btn"
          style={{
            background: !editingId ? "var(--primary)" : "var(--surface)",
            color: !editingId ? "#fff" : "var(--text-muted)",
            border: "1px dashed var(--border)",
            padding: "0.5rem 1rem",
          }}
        >
          <Plus size={16} /> Novo cliente
        </button>
      </div>

      {/* Status do cliente selecionado */}
      <div className="card-grid">
        <div className="card">
          <div className="card-title">Perfil</div>
          <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>{formData.name || "Novo cliente"}</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
            {current?.updatedAt ? new Date(current.updatedAt).toLocaleString("pt-BR") : "ainda não salvo"}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Banco D1</div>
          <div style={{ fontSize: "1.1rem", fontWeight: 600, color: health?.database?.ok ? "var(--success)" : "var(--danger)" }}>
            {health?.database?.ok ? "Conectado" : "Sem acesso"}
          </div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
            {health?.database?.ok
              ? `${health.database.events} eventos · ${health.database.purchases} vendas · ${health.database.leads} leads`
              : health?.database?.detail || "—"}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Worker</div>
          <div style={{ fontSize: "1.1rem", fontWeight: 600, color: health?.worker?.ok ? "var(--success)" : "var(--text-muted)" }}>
            {health?.worker?.ok ? "No ar" : "Não publicado"}
          </div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem", wordBreak: "break-all" }}>
            {state?.customDomain ? "domínio próprio ✓" : health?.worker?.url || "—"}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Container GTM</div>
          <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>{state?.containerId || "—"}</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
            {state?.lastRunAt ? `Último setup: ${new Date(state.lastRunAt).toLocaleString("pt-BR")}` : "—"}
          </div>
        </div>
      </div>

      {editingId && (
        <AnalystChecklist state={state} formData={formData} secretsSaved={secretsSaved} health={health} />
      )}

      {editingId && <ProductTracking />}

      {editingId && <GoogleAdsAccounts produtos={produtos} />}

      {/* Endpoints */}
      {state?.endpoints && (
        <div className="table-container" style={{ marginBottom: "2rem" }}>
          <div className="table-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>Endpoints de {formData.name}</h2>
            <button className="btn" style={{ background: "var(--surface-hover)", color: "var(--text-main)" }} onClick={loadHealth}>
              <Activity size={16} /> Testar
            </button>
          </div>
          <table>
            <tbody>
              {[
                ["Webhook da plataforma de venda", state.endpoints.webhook],
                ["Hits do GA4 (transport_url)", state.endpoints.ga4],
                ["Eventos do site", state.endpoints.collect],
                ["Snippet", state.endpoints.snippet],
                ["Saúde", state.endpoints.health],
              ].map(([label, url]: any) => (
                <tr key={label}>
                  <td style={{ width: 260, color: "var(--text-muted)", fontSize: "0.8rem" }}>{label}</td>
                  <td style={{ fontFamily: "monospace", fontSize: "0.78rem", wordBreak: "break-all" }}>{url}</td>
                  <td style={{ width: 60 }}>
                    <button
                      onClick={() => copy(url, label)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--primary)" }}
                      title="Copiar"
                    >
                      {copied === label ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2rem", alignItems: "start" }}>
        <div className="card">
          <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem", borderBottom: "1px solid var(--border)", paddingBottom: "1rem" }}>
            {editingId ? `Editando: ${formData.name}` : "Novo cliente"}
          </h2>
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "0.75rem 0 1.5rem" }}>
            Cada cliente é um perfil independente: conta Cloudflare, banco D1, container do GTM e
            domínio próprios. Salvos em <code>tracking.profiles.json</code>, fora do Git.
          </p>

          <form onSubmit={handleStartSetup}>
            {field("Nome do cliente", "name", { placeholder: "ex: Loja do João", required: true })}
            {field("Google Tag Manager Account ID", "gtmAccountId", { placeholder: "ex: 123456789", required: true })}
            {field("GA4 Measurement ID", "ga4MeasurementId", { placeholder: "ex: G-XXXXXXXX", required: true })}
            {field("Nome do Container (GTM)", "gtmContainerName", { placeholder: "ex: Loja do João - Tracking", required: true })}
            {field("Cloudflare Account ID", "cloudflareAccountId", { placeholder: "ex: 8b06XXXXXXXX", required: true })}

            <div className="form-group">
              <label className="form-label">Cloudflare API Token</label>
              <input
                type="password"
                name="cloudflareApiToken"
                className="form-input"
                placeholder={secretsSaved.cloudflareApiToken ? "•••••••• (salvo — deixe vazio para manter)" : "••••••••••••••••"}
                value={formData.cloudflareApiToken}
                onChange={handleChange}
                required={!secretsSaved.cloudflareApiToken}
              />
              <div style={{ fontSize: "0.72rem", color: "var(--warning)", marginTop: "0.35rem" }}>
                Precisa das permissões <strong>Workers Scripts: Edit</strong> e <strong>D1: Edit</strong>.
              </div>
            </div>

            {field("Domínio de rastreamento", "trackingDomain", {
              placeholder: "track.dominiodocliente.com",
              hint: "Opcional, mas recomendado. O domínio precisa estar nesta conta Cloudflare. Sem ele, usa *.workers.dev.",
            })}

            <div className="form-group">
              <label className="form-label">Domínios de checkout</label>
              <textarea
                name="checkoutDomains"
                className="form-textarea"
                style={{ minHeight: 80 }}
                placeholder="checkout.perfectpay.com.br, go.centerpag.com"
                value={formData.checkoutDomains}
                onChange={handleChange}
              />
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
                Separe por vírgula. Um clique em link para qualquer um destes domínios vira{" "}
                <code>initiate_checkout</code> e leva os indexadores (tsid, gclid, UTMs) na URL.
                <br />
                Kirvano, Hotmart, Kiwify, PerfectPay, Monetizze, Braip, Eduzz, CartPanda, Ticto,
                Greenn, Lastlink, Yampi, Appmax, Mercado Pago, PagSeguro e Stripe{" "}
                <strong>já são reconhecidos por padrão</strong> — só adicione aqui o que estiver
                fora dessa lista. O que você digitar soma, nunca substitui.
              </div>
            </div>
            {field("Nome do Worker", "workerName", { hint: "Deixe vazio para gerar automaticamente a partir do nome." })}
            {field("Nome do banco D1", "d1DatabaseName", { hint: "Deixe vazio para gerar automaticamente. O banco é criado no primeiro setup." })}

            <div className="form-group">
              <label className="form-label">Recuperação de abandono — URL do webhook</label>
              <input
                type="text"
                name="abandonedWebhookUrl"
                className="form-input"
                placeholder="https://seu-activecampaign-ou-rd/webhook"
                value={formData.abandonedWebhookUrl}
                onChange={handleChange}
              />
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
                Uma vez por dia (09:00 BRT), o Worker envia os abandonos das últimas 24h — que ainda
                não compraram — para esta URL (ActiveCampaign, RD Station, n8n…). É <strong>só
                leitura</strong> do banco, não gasta escrita do D1. Deixe vazio para desligar.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">
                Recuperação de abandono — Token (opcional)
                {secretsSaved.abandonedWebhookToken && (
                  <span style={{ color: "var(--success)" }}> — salvo</span>
                )}
              </label>
              <input
                type="password"
                name="abandonedWebhookToken"
                className="form-input"
                placeholder={secretsSaved.abandonedWebhookToken ? "•••••••• (salvo)" : "enviado como Bearer no header"}
                value={formData.abandonedWebhookToken}
                onChange={handleChange}
              />
            </div>

            <div className="form-group">
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="trackPageViews"
                  checked={formData.trackPageViews}
                  onChange={handleChange}
                  style={{ marginTop: "0.25rem" }}
                />
                <span>
                  <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>Gravar page_view no banco</span>
                  <span style={{ display: "block", fontSize: "0.72rem", color: "var(--text-muted)" }}>
                    Desligado, o banco guarda só eventos de conversão — cabe folgado no plano grátis do D1.
                    O GA4 continua recebendo os pageviews de qualquer forma.
                  </span>
                </span>
              </label>
            </div>

            {/* ---- Etapas do funil: order bump / upsell / downsell ---- */}
            <div style={{ borderTop: "1px solid var(--border)", margin: "2rem 0 1.5rem", paddingTop: "1.5rem" }}>
              <h3 style={{ fontSize: "1rem", marginBottom: "0.4rem" }}>
                Order Bump / Upsell / Downsell{" "}
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(opcional)</span>
              </h3>
              <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "1.25rem" }}>
                Order bump, upsell e downsell chegam como vendas separadas com o mesmo cliente — o que
                os diferencia é o <strong>produto</strong>. Liste aqui os IDs (ou nomes) de cada etapa,
                separados por vírgula ou quebra de linha. Prefixe com <code>re:</code> para regex. O que
                não casar com nenhuma lista é tratado como <strong>front</strong> (produto principal).
              </p>

              {(
                [
                  ["Produtos do Order Bump", "orderBumpProductIds", "ex: 998877, bump-garantia"],
                  ["Produtos de Upsell", "upsellProductIds", "ex: 445566, oferta-vip, re:upsell\\d+"],
                  ["Produtos de Downsell", "downsellProductIds", "ex: 112233, plano-basico"],
                  ["Produtos do Front (opcional)", "frontProductIds", "ex: 123456 — deixe vazio para usar como padrão"],
                ] as const
              ).map(([label, name, placeholder]) => (
                <div className="form-group" key={name}>
                  <label className="form-label">{label}</label>
                  <textarea
                    name={name}
                    className="form-textarea"
                    style={{ minHeight: "3.5rem", fontFamily: "monospace", fontSize: "0.8rem" }}
                    placeholder={placeholder}
                    value={formData[name] as string}
                    onChange={handleChange}
                  />
                </div>
              ))}
            </div>

            {/* ---- Envio de conversões ---- */}
            <div
              style={{
                borderTop: "1px solid var(--border)",
                margin: "2rem 0 1.5rem",
                paddingTop: "1.5rem",
              }}
            >
              <h3 style={{ fontSize: "1rem", marginBottom: "0.4rem" }}>
                Envio de conversões <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(opcional)</span>
              </h3>
              <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "1.25rem" }}>
                Sem isto o rastreamento só <em>guarda</em> os dados. É preenchendo aqui que a venda
                aprovada volta para o Google e para o Meta e o algoritmo passa a aprender.
                Pode deixar em branco agora e preencher depois.
              </p>

              <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#0866ff", marginBottom: "0.75rem" }}>
                Meta CAPI
              </div>
              {field("Pixel ID", "metaPixelId", { placeholder: "ex: 1234567890" })}
              <div className="form-group">
                <label className="form-label">Access Token</label>
                <input
                  type="password"
                  name="metaAccessToken"
                  className="form-input"
                  placeholder={secretsSaved.metaAccessToken ? "•••••••• (salvo — deixe vazio para manter)" : "EAAG..."}
                  value={formData.metaAccessToken}
                  onChange={handleChange}
                />
                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
                  Events Manager → Configurações → API de Conversões → Gerar token de acesso.
                </div>
              </div>
              {field("Código de evento de teste", "metaTestEventCode", {
                placeholder: "TEST12345",
                hint: "Só para validar no Events Manager. Remova depois de confirmar que chega.",
              })}

              <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#fbbc04", margin: "1.5rem 0 0.75rem" }}>
                Google Ads — conversões offline
              </div>
              {field("Customer ID", "googleAdsCustomerId", { placeholder: "123-456-7890" })}
              {field("ID da ação de conversão", "googleAdsConversionActionId", {
                placeholder: "ex: 987654321",
                hint: "Crie uma conversão do tipo “Importar → De cliques” no Google Ads e pegue o ID na URL.",
              })}
              {field("Login Customer ID (MCC)", "googleAdsLoginCustomerId", {
                placeholder: "opcional, só se acessar via MCC",
              })}
              {field("OAuth Client ID", "googleAdsClientId", { placeholder: "...apps.googleusercontent.com" })}
              <div className="form-group">
                <label className="form-label">OAuth Client Secret</label>
                <input
                  type="password"
                  name="googleAdsClientSecret"
                  className="form-input"
                  placeholder={secretsSaved.googleAdsClientSecret ? "•••••••• (salvo)" : "GOCSPX-..."}
                  value={formData.googleAdsClientSecret}
                  onChange={handleChange}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Refresh Token</label>
                <input
                  type="password"
                  name="googleAdsRefreshToken"
                  className="form-input"
                  placeholder={secretsSaved.googleAdsRefreshToken ? "•••••••• (salvo)" : "1//..."}
                  value={formData.googleAdsRefreshToken}
                  onChange={handleChange}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Developer Token</label>
                <input
                  type="password"
                  name="googleAdsDeveloperToken"
                  className="form-input"
                  placeholder={secretsSaved.googleAdsDeveloperToken ? "•••••••• (salvo)" : "seu developer token"}
                  value={formData.googleAdsDeveloperToken}
                  onChange={handleChange}
                />
                <div style={{ fontSize: "0.72rem", color: "var(--warning)", marginTop: "0.35rem" }}>
                  Precisa de aprovação do Google (API Center → acesso básico). Costuma levar alguns dias.
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">
                Google Service Account JSON{" "}
                {serviceAccountSaved && <span style={{ color: "var(--success)" }}>— já salvo (vale para todos os clientes)</span>}
              </label>
              <textarea
                name="serviceAccountJson"
                className="form-textarea"
                placeholder={serviceAccountSaved ? "(salvo)" : '{\n  "type": "service_account",\n  ...\n}'}
                value={formData.serviceAccountJson}
                onChange={handleChange}
                required={!serviceAccountSaved}
              />
            </div>

            {passwordRequired && (
              <div className="form-group">
                <label className="form-label">Senha de setup</label>
                <input type="password" name="setupPassword" className="form-input" value={formData.setupPassword} onChange={handleChange} required />
              </div>
            )}

            <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
              {editingId && (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="btn"
                  style={{ background: "var(--surface-hover)", color: "var(--danger)" }}
                  disabled={loading || saving}
                  title="Remover perfil"
                >
                  <Trash2 size={18} />
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                className="btn"
                style={{ flex: 1, background: "var(--surface-hover)", color: "var(--text-main)" }}
                disabled={saving || loading}
              >
                {saving ? <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={18} />}
                Só salvar
              </button>
              <button type="submit" className="btn btn-primary" style={{ flex: 2 }} disabled={loading || saving}>
                {loading ? <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={20} />}
                {loading ? "Configurando..." : "Salvar e rodar setup"}
              </button>
            </div>
          </form>
        </div>

        <div className="card" style={{ alignSelf: "start", position: "sticky", top: "2rem" }}>
          <h2 style={{ fontSize: "1.25rem", marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            Terminal
            {status === "success" && <CheckCircle size={20} style={{ color: "var(--success)" }} />}
            {status === "error" && <AlertCircle size={20} style={{ color: "var(--danger)" }} />}
            {status === "running" && (
              <span style={{ fontSize: "0.8rem", fontWeight: 400, color: "var(--text-muted)", marginLeft: "auto" }}>
                {Math.floor(elapsed / 60)}m {String(elapsed % 60).padStart(2, "0")}s
              </span>
            )}
          </h2>
          {status === "running" && (
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
              A etapa do GTM leva ~2 min: a API do Google limita 30 chamadas por minuto e o setup cria
              cerca de 45 itens. Pode deixar rodando.
            </div>
          )}
          <div className="terminal-log">
            {logs ||
              "Cadastre um cliente e clique em “Salvar e rodar setup”.\nDepois é só voltar aqui, escolher o cliente na aba e rodar de novo.\n\nO setup é idempotente: reaproveita container do GTM, banco D1 e Worker existentes."}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
