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
    <header className="glass bg-[rgba(10,15,26,0.8)] border-b border-hxa-border flex items-center px-5 max-md:px-3 gap-4 max-md:gap-2 h-14 max-md:h-12 shrink-0 z-10">
      {/* Mobile menu button */}
      <button
        onClick={onMenuToggle}
        className="md:hidden text-hxa-text-dim hover:text-hxa-text p-1"
      >
        <Menu size={20} />
      </button>

      {/* Brand */}
      <div className="flex items-center gap-2 text-hxa-text font-semibold">
        <img src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/images/logo.png`} alt="HXA-Connect" className="h-5" />
        <span className="font-semibold text-[15px] max-md:max-w-[100px] max-md:truncate">{session?.org_name || 'HXA-Connect'}</span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* WS status — hidden on mobile */}
      {wsConnected !== undefined && (
        <span className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-hxa-border text-xs font-mono">
          <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-hxa-green animate-pulse' : 'bg-hxa-red'}`} />
          <span className="text-hxa-text-dim">{wsConnected ? 'Connected' : 'Disconnected'}</span>
        </span>
      )}

      {/* Session info */}
      {session && (
        <div className="flex items-center gap-2 max-md:gap-1.5">
          <div className="text-xs font-mono flex items-center gap-1.5 text-hxa-text-dim bg-black/30 px-2.5 py-1.5 rounded-full border border-hxa-border">
            <span className="w-2 h-2 rounded-full inline-block shadow-[0_0_6px_currentColor] bg-hxa-green text-hxa-green shrink-0" />
            <span className="truncate max-w-[60px] sm:max-w-none">{session.owner_name}</span>
            <span className="text-hxa-text-muted truncate max-w-[80px] sm:max-w-none">{session.bot?.name ?? ''}</span>
          </div>
          <button
            onClick={() => setShowLogoutConfirm(true)}
            className="text-hxa-text-dim hover:text-hxa-red transition-colors inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
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
