import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getProfile } from "../../../lib/profiles";

export const dynamic = "force-dynamic";

const COOKIE = "tracking_produto";

/** Lista de produtos com propriedade GA4 + container GTM proprios, para o seletor. */
export async function GET() {
  const profile = getProfile(null);
  let produtos: { product: string; containerId: string | null }[] = [];
  try {
    const ga4 = JSON.parse(profile?.productGa4Properties || "[]");
    const gtm = JSON.parse(profile?.productGtmContainers || "[]");
    produtos = ga4.map((p: any) => ({
      product: p.product,
      containerId: gtm.find((c: any) => c.product === p.product)?.containerId || null,
    }));
  } catch {
    produtos = [];
  }

  const selected = cookies().get(COOKIE)?.value || "";
  return NextResponse.json({ produtos, selected });
}

export async function PUT(request: Request) {
  const { product } = await request.json();
  const jar = cookies();
  if (!product) jar.delete(COOKIE);
  else jar.set(COOKIE, product, { path: "/", maxAge: 60 * 60 * 24 * 90 });
  return NextResponse.json({ ok: true });
}
