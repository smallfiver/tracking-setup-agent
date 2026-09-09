import { NextResponse } from "next/server";
import fs from "fs/promises";
import {
  readProfiles,
  saveProfile,
  setActiveProfile,
  deleteProfile,
  publicProfile,
  hasServiceAccount,
  PROFILES_PATH,
  SERVICE_ACCOUNT_PATH,
} from "../../../lib/profiles";
import { authorize } from "../../../lib/auth";

export const dynamic = "force-dynamic";

/** Lista os perfis (sem segredos) e qual esta ativo. */
export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const store = readProfiles();
  const profiles = Object.entries(store.profiles).map(([id, profile]) => ({
    id,
    ...publicProfile(profile),
  }));

  return NextResponse.json({
    activeProfile: store.activeProfile,
    profiles,
    serviceAccountSaved: hasServiceAccount(),
    passwordRequired: Boolean(process.env.SETUP_PASSWORD),
    profilesPath: PROFILES_PATH,
  });
}

/** Cria ou atualiza um perfil. */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const denied = authorize(request, body.setupPassword);
    if (denied) return NextResponse.json({ error: denied }, { status: 401 });

    if (body.serviceAccountJson && String(body.serviceAccountJson).trim()) {
      try {
        JSON.parse(body.serviceAccountJson);
      } catch {
        return NextResponse.json({ error: "O JSON da service account é inválido." }, { status: 400 });
      }
      await fs.writeFile(SERVICE_ACCOUNT_PATH, body.serviceAccountJson, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }

    const { id, profile } = saveProfile(body.id || null, body);
    if (body.makeActive !== false) setActiveProfile(id);

    return NextResponse.json({ success: true, id, profile: publicProfile(profile) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}

/** Troca o perfil ativo. */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const denied = authorize(request, body.setupPassword);
    if (denied) return NextResponse.json({ error: denied }, { status: 401 });

    setActiveProfile(body.id);
    return NextResponse.json({ success: true, activeProfile: body.id });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 400 });
  }
}

/** Remove um perfil do painel (nao apaga nada na Cloudflare nem no GTM). */
export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const denied = authorize(request, body.setupPassword);
    if (denied) return NextResponse.json({ error: denied }, { status: 401 });

    const store = deleteProfile(body.id);
    return NextResponse.json({ success: true, activeProfile: store.activeProfile });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 400 });
  }
}
