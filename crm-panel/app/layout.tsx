import './globals.css';
import { BarChart3 } from 'lucide-react';
import ProfileSwitcher from './ProfileSwitcher';
import ProductSelector from './ProductSelector';
import NavLinks from './NavLinks';

export const metadata = {
  title: 'Tracking CRM Panel',
  description: 'Premium CRM Panel for Tracking Data',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>
        <div className="layout-container">
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-mark">
                <BarChart3 size={17} />
              </div>
              <div>
                <h1>Tracking CRM</h1>
                <div className="brand-sub">GTM · GA4 · Cloudflare</div>
              </div>
            </div>
            <ProfileSwitcher />
            <ProductSelector />
            <nav>
              <NavLinks />
            </nav>
            <div className="sidebar-footer">
              <span className="status-dot ok" />
              Painel operando
            </div>
          </aside>
          <main className="main-content">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
