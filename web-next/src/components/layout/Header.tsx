'use client';

import { Zap, LogOut, Menu } from 'lucide-react';
import { useSession } from '@/hooks/useSession';
import { useRouter } from 'next/navigation';

interface HeaderProps {
  onMenuToggle?: () => void;
  wsConnected?: boolean;
}

export function Header({ onMenuToggle, wsConnected }: HeaderProps) {
  const { session, logout } = useSession();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.replace('/');
  }

  return (
    <header className="glass bg-[rgba(10,15,26,0.8)] border-b border-hxa-border flex items-center px-5 gap-4 h-14 shrink-0 z-10">
      {/* Mobile menu button */}
      <button
        onClick={onMenuToggle}
        className="md:hidden border border-hxa-border text-hxa-text p-1.5 rounded-lg hover:bg-white/5"
      >
        <Menu size={18} />
      </button>

      {/* Brand */}
      <div className="flex items-center gap-2 text-hxa-text font-semibold">
        <Zap size={18} className="text-hxa-accent" />
        <span>HXA-Connect</span>
      </div>

      {/* WS status */}
      {wsConnected !== undefined && (
        <span className="flex items-center gap-1 text-[10px] text-hxa-text-muted">
          {wsConnected ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-hxa-green shadow-[0_0_4px_currentColor] text-hxa-green" />
              <span className="hidden sm:inline">Live</span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-hxa-red shadow-[0_0_4px_currentColor] text-hxa-red" />
              <span className="hidden sm:inline">Offline</span>
            </>
          )}
        </span>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Session info */}
      {session && (
        <div className="flex items-center gap-3">
          <div className="text-sm font-mono flex items-center gap-2 text-hxa-text-dim bg-black/30 px-3 py-1.5 rounded-full border border-hxa-border">
            <span className="w-2 h-2 rounded-full inline-block shadow-[0_0_6px_currentColor] bg-hxa-green text-hxa-green" />
            <span className="hidden sm:inline">{session.owner_name}</span>
            <span className="text-xs text-hxa-text-muted">{session.bot.name}</span>
          </div>
          <button
            onClick={handleLogout}
            className="border border-white/15 text-hxa-text-dim text-xs px-2.5 py-1.5 rounded-md hover:border-hxa-red hover:text-hxa-red transition-colors inline-flex items-center gap-1.5"
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      )}
    </header>
  );
}
