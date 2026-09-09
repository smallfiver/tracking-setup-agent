/**
 * As rotas de configuracao gravam credenciais em disco e executam um processo
 * no servidor. Por isso so aceitam chamadas locais — ou, se SETUP_PASSWORD
 * estiver definido no .env.local, chamadas que apresentem essa senha.
 */
export function authorize(request: Request, provided?: string): string | null {
  const expected = process.env.SETUP_PASSWORD;

  if (expected) {
    return provided === expected
      ? null
      : "Senha de setup incorreta.";
  }

  const host = (request.headers.get("host") || "").split(":")[0];
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  return isLocal
    ? null
    : "Esta rota só pode ser usada localmente. Defina SETUP_PASSWORD no .env.local para liberá-la remotamente.";
}
