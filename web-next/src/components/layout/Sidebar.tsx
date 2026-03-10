'use client';

import { useSession } from '@/hooks/useSession';
import { MessageSquare, Mail, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/i18n/context';

type Tab = 'threads' | 'dms';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  children?: React.ReactNode;
}

export function Sidebar({ open, onClose, activeTab, onTabChange, children }: SidebarProps) {
  const { t } = useTranslations();
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'threads', label: t('sidebar.threads'), icon: <MessageSquare size={14} /> },
    { id: 'dms', label: t('sidebar.dms'), icon: <Mail size={14} /> },
  ];

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div className="fixed inset-0 bg-black/60 glass z-[999] md:hidden" onClick={onClose} />
      )}

      <aside
        className={cn(
          'glass bg-hxa-bg-secondary border-r border-hxa-border flex flex-col w-[300px] shrink-0 overflow-hidden',
          'max-md:fixed max-md:top-0 max-md:left-0 max-md:bottom-0 max-md:z-[1000] max-md:transition-transform max-md:duration-300',
          open ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
        )}
      >
        {/* Mobile close button */}
        <button
          onClick={onClose}
          className="md:hidden absolute top-3 right-3 text-hxa-text-dim hover:text-hxa-text p-1"
        >
          <X size={18} />
        </button>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-hxa-border bg-black/20">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                'flex-1 py-3.5 text-center text-sm font-semibold relative transition-colors',
                activeTab === tab.id
                  ? 'text-hxa-accent'
                  : 'text-hxa-text-dim hover:text-hxa-text hover:bg-white/[0.02]',
              )}
            >
              <span className="inline-flex items-center gap-1.5">
                {tab.icon}
                {tab.label}
              </span>
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-hxa-accent to-hxa-purple" />
              )}
            </button>
          ))}
        </div>

        {/* Panel content */}
        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {children}
        </div>
      </aside>
    </>
  );
}
