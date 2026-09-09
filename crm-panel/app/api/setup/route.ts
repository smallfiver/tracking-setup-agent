import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import {
  saveProfile,
  setActiveProfile,
  getProfile,
  readProfiles,
  AGENT_ROOT,
  SERVICE_ACCOUNT_PATH,
  PROFILES_PATH,
  ENV_MAP,
  REQUIRED_FIELDS,
  SOMENTE_LEITURA,
} from "../../../lib/profiles";
import { authorize } from "../../../lib/auth";

export const maxDuration = 900;
export const dynamic = "force-dynamic";

/** Marcador que separa o log do resultado final no stream (espelhado no cliente). */
const RESULT_MARKER = "\n__SETUP_RESULT__";

/**
 * Salva o perfil e executa o setup.mjs, transmitindo o log em tempo real.
 * A etapa do GTM leva ~2 min por causa da cota de 30 chamadas/min da API.
 */
export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Payload inválido." }, { status: 400 });
  }

  // O setup roda um processo do repositorio; em servidor gerenciado isso nao existe.
  if (SOMENTE_LEITURA) {
    return NextResponse.json(
      {
        success: false,
        error:
          "O setup so roda na sua maquina. Neste deploy o painel e somente leitura: " +
          "rode o setup local e atualize a variavel TRACKING_PROFILES.",
      },
      { status: 400 }
    );
  }

  const denied = authorize(request, body.setupPassword);
  if (denied) return NextResponse.json({ success: false, error: denied }, { status: 401 });

  // 1. Service account (compartilhada entre os perfis).
  if (body.serviceAccountJson && String(body.serviceAccountJson).trim()) {
    try {
      JSON.parse(body.serviceAccountJson);
    } catch {
      return NextResponse.json(
        { success: false, error: "O JSON da service account é inválido." },
        { status: 400 }
      );
    }
    await fs.writeFile(SERVICE_ACCOUNT_PATH, body.serviceAccountJson, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  try {
    await fs.access(SERVICE_ACCOUNT_PATH);
  } catch {
    return NextResponse.json(
      { success: false, error: "Cole o JSON da service account do Google — ele ainda não foi salvo." },
      { status: 400 }
    );
  }

  // 2. Salva o perfil (segredos vazios preservam o que ja estava salvo).
  const { id, profile } = saveProfile(body.id || null, body);
  setActiveProfile(id);

  const missing = REQUIRED_FIELDS.filter((key) => !profile[key]);
  if (missing.length) {
    const labels = missing.map((k) => ENV_MAP[k] || k).join(", ");
    return NextResponse.json(
      { success: false, error: `Configuração incompleta: ${labels}.` },
      { status: 400 }
    );
  }

  // 3. Ambiente: o perfil e a fonte da verdade. Removemos qualquer valor herdado
  //    do painel para que nada sobreponha o que voce acabou de salvar.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    SETUP_PROFILE: id,
    GOOGLE_APPLICATION_CREDENTIALS: SERVICE_ACCOUNT_PATH,
    TRACK_PAGE_VIEWS: profile.trackPageViews ? "true" : "false",
  };
  for (const [key, envName] of Object.entries(ENV_MAP)) {
    if (profile[key]) env[envName] = String(profile[key]);
    else delete env[envName];
  }

  // 4. Executa transmitindo a saida linha a linha.
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const child = spawn(process.execPath, ["setup.mjs"], { cwd: AGENT_ROOT, env });

      let closed = false;
      const push = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };

      child.stdout.on("data", (chunk) => push(chunk.toString()));
      child.stderr.on("data", (chunk) => push(chunk.toString()));

      const timeout = setTimeout(() => {
        push("\n⏱ Tempo limite de 12 minutos atingido — encerrando.\n");
        child.kill();
      }, 12 * 60 * 1000);

      const finish = (payload: Record<string, any>) => {
        clearTimeout(timeout);
        push(RESULT_MARKER + JSON.stringify(payload));
        closed = true;
        controller.close();
      };

      child.on("error", (err) => finish({ success: false, error: err.message }));
      child.on("close", (code) =>
        finish({
          success: code === 0,
          exitCode: code,
          profileId: id,
          profilesPath: PROFILES_PATH,
          state: getProfile(id)?.state || null,
          activeProfile: readProfiles().activeProfile,
        })
      );
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
