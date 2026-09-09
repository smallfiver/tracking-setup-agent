/**
 * Barra de magnitude inline para células de tabela — permite comparar valores
 * de uma coluna visualmente sem precisar de um gráfico separado (o número
 * exato continua sempre visível ao lado, nunca só a barra).
 */
export default function MiniBar({ value, max, color }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, 2) : 0;
  return (
    <div className="mini-bar-track">
      <div className="mini-bar-fill" style={{ width: `${pct}%`, background: color || "var(--chart-1)" }} />
    </div>
  );
}
