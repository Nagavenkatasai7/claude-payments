import type { ReactNode } from 'react';
import { TopBar } from './top-bar';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="sh-app">
      <TopBar />
      <div className="sh-body">{children}</div>
    </div>
  );
}
