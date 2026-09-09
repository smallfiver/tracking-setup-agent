import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Porta de entrada do painel.
 *
 * O painel mostra e-mail, telefone e CPF de clientes reais. Publicado sem
 * protecao, isso vira vazamento de dado pessoal de terceiros — por isso o
 * acesso remoto so e liberado com senha.
 *
 * Local (localhost) segue livre, para nao atrapalhar o desenvolvimento.
 */

/** Comparacao de tempo constante: nao revela o tamanho da senha por timing. */
function senhaConfere(recebida: string, esperada: string): boolean {
  if (recebida.length !== esperada.length) return false;
  let diff = 0;
  for (let i = 0; i < recebida.length; i++) {
    diff |= recebida.charCodeAt(i) ^ esperada.charCodeAt(i);
  }
  return diff === 0;
}

function pedirSenha() {
  return new NextResponse("Acesso restrito.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Tracking CRM", charset="UTF-8"' }
  });
}

export function middleware(request: NextRequest) {
  const senha = process.env.PANEL_PASSWORD;
  const host = (request.headers.get("host") || "").split(":")[0];
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";

  if (!senha) {
    if (local) return NextResponse.next();
    // Sem senha definida, um deploy publico ficaria aberto. Melhor recusar.
    return new NextResponse(
      "Este painel esta sem senha. Defina a variavel PANEL_PASSWORD no ambiente " +
        "(na Vercel: Settings > Environment Variables) e faca o deploy de novo.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }

  const header = request.headers.get("authorization");
  if (!header) return pedirSenha();

  const [esquema, codificado] = header.split(" ");
  if (esquema !== "Basic" || !codificado) return pedirSenha();

  let recebida = "";
  try {
    // O usuario pode ser qualquer coisa; so a senha importa.
    recebida = atob(codificado).split(":").slice(1).join(":");
  } catch {
    return pedirSenha();
  }

  return senhaConfere(recebida, senha) ? NextResponse.next() : pedirSenha();
}

export const config = {
  // Arquivos estaticos do Next ficam de fora para nao quebrar o carregamento.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
