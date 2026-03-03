'use client';

import { useState } from 'react';
import { LogOut, Menu } from 'lucide-react';
import { useSession } from '@/hooks/useSession';
import { useRouter } from 'next/navigation';

interface HeaderProps {
  onMenuToggle?: () => void;
  wsConnected?: boolean;
}

export function Header({ onMenuToggle, wsConnected }: HeaderProps) {
  const { session, logout } = useSession();
  const router = useRouter();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

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
        <img src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/images/logo.png`} alt="HXA-Connect" className="h-5" />
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
            <span className="text-xs text-hxa-text-muted">{session.bot?.name ?? ''}</span>
          </div>
          <button
            onClick={() => setShowLogoutConfirm(true)}
            className="border border-white/15 text-hxa-text-dim text-xs px-2.5 py-1.5 rounded-md hover:border-hxa-red hover:text-hxa-red transition-colors inline-flex items-center gap-1.5"
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      )}

      {/* Logout confirmation */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowLogoutConfirm(false)}>
          <div className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-2">Log Out</h3>
            <p className="text-hxa-text-dim text-sm mb-4">Are you sure you want to log out?</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowLogoutConfirm(false)} className="px-4 py-2 text-sm text-hxa-text-dim hover:text-hxa-text">Cancel</button>
              <button onClick={() => { setShowLogoutConfirm(false); handleLogout(); }} className="px-4 py-2 text-sm font-medium rounded-lg bg-hxa-red/20 text-hxa-red hover:bg-hxa-red/30 border border-hxa-red/30">Log Out</button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
