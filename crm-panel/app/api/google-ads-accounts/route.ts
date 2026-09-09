import { NextResponse } from "next/server";
import { query, safeQuery } from "../../../lib/db";
import { getProfile } from "../../../lib/profiles";

export const dynamic = "force-dynamic";

/**
 * Contas do Google Ads conectadas — uma linha por conta, cada uma com o seu
 * refresh token. E isto que permite trabalhar com varias contas isoladas em
 * vez de depender de uma MCC unica.
 *
 * O refresh token NUNCA sai daqui para o navegador: a listagem devolve apenas
 * um booleano dizendo se a conta ja foi conectada.
 */

function randomSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function GET() {
  const profile = getProfile(null);
  const workerUrl = profile?.trackingDomain ? `https://${profile.trackingDomain}` : null;

  const { rows, error } = await safeQuery(
    `SELECT id, label, customer_id, login_customer_id, conversion_action_id,
            google_email, products, enabled, oauth_state, last_error, updated_at,
            CASE WHEN refresh_token IS NOT NULL THEN 1 ELSE 0 END AS conectada
     FROM google_ads_accounts ORDER BY id`
  );

  if (error) {
    const semTabela = /no such table/i.test(error);
    return NextResponse.json({
      accounts: [],
      workerUrl,
      error: semTabela
        ? "A tabela de contas ainda não existe. Rode o setup para migrar o banco."
        : error,
    });
  }

  const accounts = rows.map((r) => ({
    id: Number(r.id),
    label: r.label || "",
    customerId: r.customer_id || "",
    loginCustomerId: r.login_customer_id || "",
    conversionActionId: r.conversion_action_id || "",
    googleEmail: r.google_email || null,
    products: (() => {
      try {
        return JSON.parse(String(r.products || "[]"));
      } catch {
        return [];
      }
    })(),
    enabled: Number(r.enabled) === 1,
    conectada: Number(r.conectada) === 1,
    lastError: r.last_error || null,
    updatedAt: r.updated_at || null,
    // Link de conexão só existe enquanto a conta não foi conectada.
    connectUrl:
      Number(r.conectada) === 0 && r.oauth_state && workerUrl
        ? `${workerUrl}/oauth/google/start?state=${r.id}.${r.oauth_state}`
        : null,
  }));

  return NextResponse.json({ accounts, workerUrl, error: null });
}

export async function POST(request: Request) {
  const body = await request.json();
  const label = String(body.label || "").trim();
  const customerId = String(body.customerId || "").replace(/\D/g, "");
  const loginCustomerId = String(body.loginCustomerId || "").replace(/\D/g, "");
  const conversionActionId = String(body.conversionActionId || "").replace(/\D/g, "");
  const products = Array.isArray(body.products) ? body.products : [];

  if (!label) return NextResponse.json({ error: "Dê um nome para a conta." }, { status: 400 });
  if (!customerId) return NextResponse.json({ error: "Informe o Customer ID." }, { status: 400 });

  try {
    await query(
      `INSERT INTO google_ads_accounts
        (label, customer_id, login_customer_id, conversion_action_id, products, oauth_state)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [label, customerId, loginCustomerId || null, conversionActionId || null, JSON.stringify(products), randomSecret()]
    );
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    const duplicado = /UNIQUE constraint/i.test(err.message);
    return NextResponse.json(
      { error: duplicado ? "Já existe uma conta com esse Customer ID." : err.message },
      { status: 400 }
    );
  }
}

export async function PUT(request: Request) {
  const body = await request.json();
  const id = Number(body.id);
  if (!id) return NextResponse.json({ error: "Conta não informada." }, { status: 400 });

  // Reconectar: sorteia um state novo e limpa o token antigo.
  if (body.action === "reconnect") {
    await query(
      `UPDATE google_ads_accounts SET refresh_token = NULL, google_email = NULL,
       oauth_state = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [randomSecret(), id]
    );
    return NextResponse.json({ ok: true });
  }

  const sets: string[] = [];
  const params: any[] = [];
  const campos: Record<string, string> = {
    label: "label",
    conversionActionId: "conversion_action_id",
    loginCustomerId: "login_customer_id",
  };
  for (const [chave, coluna] of Object.entries(campos)) {
    if (body[chave] !== undefined) {
      sets.push(`${coluna} = ?`);
      params.push(String(body[chave]).trim() || null);
    }
  }
  if (body.products !== undefined) {
    sets.push("products = ?");
    params.push(JSON.stringify(Array.isArray(body.products) ? body.products : []));
  }
  if (body.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(body.enabled ? 1 : 0);
  }
  if (!sets.length) return NextResponse.json({ error: "Nada para atualizar." }, { status: 400 });

  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);
  await query(`UPDATE google_ads_accounts SET ${sets.join(", ")} WHERE id = ?`, params);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const { id } = await request.json();
  if (!id) return NextResponse.json({ error: "Conta não informada." }, { status: 400 });
  await query("DELETE FROM google_ads_accounts WHERE id = ?", [Number(id)]);
  return NextResponse.json({ ok: true });
}
