import { NextResponse } from "next/server";
import { safeQuery } from "../../../lib/db";
import { getProfile, readProfiles } from "../../../lib/profiles";

export const dynamic = "force-dynamic";

/** Diagnostico do perfil ativo: D1 acessivel pelo painel + Worker no ar. */
export async function GET() {
  const store = readProfiles();
  const profile = getProfile(null);

  const result: any = {
    activeProfile: store.activeProfile,
    profileName: profile?.name || null,
    configured: Boolean(profile?.cloudflareAccountId),
    database: { ok: false, detail: "não configurado" },
    worker: { ok: false, detail: "nunca publicado" },
    state: profile?.state || null,
  };

  const { rows, error } = await safeQuery(`
    SELECT
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM purchases) AS purchases,
      (SELECT COUNT(*) FROM leads) AS leads
  `);

  result.database = error
    ? { ok: false, detail: error }
    : {
        ok: true,
        events: Number(rows[0]?.events || 0),
        purchases: Number(rows[0]?.purchases || 0),
        leads: Number(rows[0]?.leads || 0),
      };

  const workerUrl = profile?.state?.workersDevUrl || profile?.state?.workerUrl;
  if (workerUrl) {
    try {
      const res = await fetch(`${workerUrl}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json();
      result.worker = body?.ok
        ? { ok: true, url: profile.state.workerUrl, events: body.events, trackPageViews: body.trackPageViews }
        : { ok: false, url: workerUrl, detail: body?.error || `HTTP ${res.status}` };
    } catch (err: any) {
      result.worker = { ok: false, url: workerUrl, detail: err.message };
    }
  }

  return NextResponse.json(result);
}
