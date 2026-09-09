"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ShoppingCart,
  Activity,
  Settings,
  Users,
  Send,
  Radio,
  Package,
  Stethoscope,
  ShoppingBag,
} from "lucide-react";

const SECTIONS: { label: string; items: { href: string; label: string; icon: any }[] }[] = [
  {
    label: "Análise",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/map", label: "Ao Vivo", icon: Radio },
      { href: "/ofertas", label: "Ofertas", icon: Package },
      { href: "/diagnostico", label: "Diagnóstico", icon: Stethoscope },
    ],
  },
  {
    label: "Ação",
    items: [{ href: "/recuperacao", label: "Recuperação", icon: ShoppingBag }],
  },
  {
    label: "Dados",
    items: [
      { href: "/purchases", label: "Compras", icon: ShoppingCart },
      { href: "/events", label: "Eventos", icon: Activity },
      { href: "/leads", label: "Leads", icon: Users },
      { href: "/conversions", label: "Conversões", icon: Send },
    ],
  },
  {
    label: "Sistema",
    items: [{ href: "/settings", label: "Configurações", icon: Settings }],
  },
];

/** Navegação lateral com destaque de rota ativa (nav-state-active). */
export default function NavLinks() {
  const pathname = usePathname();

  return (
    <>
      {SECTIONS.map((section) => (
        <div key={section.label}>
          <div className="nav-section-label">{section.label}</div>
          {section.items.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname?.startsWith(href);
            return (
              <Link key={href} href={href} className={`nav-link${active ? " active" : ""}`}>
                <Icon size={18} />
                {label}
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}
