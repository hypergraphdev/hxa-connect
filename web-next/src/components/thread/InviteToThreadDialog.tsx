'use client';

import { useState, useEffect, useMemo } from 'react';
import { X, Search, Circle, UserPlus } from 'lucide-react';
import { useTranslations } from '@/i18n/context';

interface BotItem {
  id: string;
  name: string;
  online: boolean;
}

interface InviteToThreadDialogProps {
  open: boolean;
  onClose: () => void;
  onInvite: (botId: string, label?: string) => void;
  fetchBots: () => Promise<{ items: BotItem[] }>;
  inviting?: boolean;
}

export function InviteToThreadDialog({
  open,
  onClose,
  onInvite,
  fetchBots,
  inviting,
}: InviteToThreadDialogProps) {
  const { t } = useTranslations();
  const [bots, setBots] = useState<BotItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedBot, setSelectedBot] = useState<BotItem | null>(null);
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!open) {
      setSearch('');
      setSelectedBot(null);
      setLabel('');
      return;
    }
    setLoading(true);
    fetchBots()
      .then(res => setBots(res.items ?? []))
      .catch(() => setBots([]))
      .finally(() => setLoading(false));
  }, [open, fetchBots]);

  const filtered = useMemo(() => {
    if (!search.trim()) return bots;
    const q = search.toLowerCase();
    return bots.filter(b => b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q));
  }, [bots, search]);

  if (!open) return null;

  function handleInvite() {
    if (!selectedBot) return;
    onInvite(selectedBot.id, label.trim() || undefined);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-5 max-w-md w-full mx-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-hxa-text flex items-center gap-1.5">
            <UserPlus size={14} className="text-hxa-accent" />
            {t('thread.inviteBot')}
          </h3>
          <button onClick={onClose} className="text-hxa-text-dim hover:text-hxa-text">
            <X size={16} />
          </button>
        </div>

        {!selectedBot ? (
          <>
            {/* Search */}
            <div className="relative mb-3">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hxa-text-muted" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('thread.inviteBot.search')}
                className="w-full text-xs pl-7 pr-3 py-2 bg-black/30 border border-hxa-border rounded-lg text-hxa-text placeholder:text-hxa-text-muted focus:outline-none focus:border-hxa-accent/50"
              />
            </div>

            {/* Bot list */}
            <div className="max-h-[240px] overflow-y-auto space-y-1">
              {loading ? (
                <div className="flex items-center justify-center py-6">
                  <div className="h-5 w-5 rounded-full border-2 border-hxa-accent/20 border-t-hxa-accent animate-spin" />
                </div>
              ) : filtered.length === 0 ? (
                <p className="text-xs text-hxa-text-muted text-center py-6">{t('thread.inviteBot.noBots')}</p>
              ) : (
                filtered.map(bot => (
                  <button
                    key={bot.id}
                    onClick={() => setSelectedBot(bot)}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/[0.04] transition-colors"
                  >
                    <Circle
                      size={7}
                      className={bot.online ? 'fill-emerald-400 text-emerald-400' : 'fill-hxa-text-dim text-hxa-text-dim'}
                    />
                    <span className="text-xs text-hxa-text flex-1 truncate">{bot.name}</span>
                    <span className="text-[10px] text-hxa-text-muted font-mono">{bot.id.slice(0, 8)}</span>
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            {/* Selected bot */}
            <div className="mb-3 px-3 py-2 rounded-lg bg-hxa-accent/10 border border-hxa-accent/20 flex items-center gap-2">
              <Circle
                size={7}
                className={selectedBot.online ? 'fill-emerald-400 text-emerald-400' : 'fill-hxa-text-dim text-hxa-text-dim'}
              />
              <span className="text-xs text-hxa-text font-medium flex-1">{selectedBot.name}</span>
              <button onClick={() => setSelectedBot(null)} className="text-hxa-text-muted hover:text-hxa-text">
                <X size={12} />
              </button>
            </div>

            {/* Label input */}
            <div className="mb-4">
              <label className="text-[11px] text-hxa-text-dim mb-1 block">{t('thread.inviteBot.label')}</label>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleInvite(); } }}
                placeholder={t('thread.inviteBot.labelHint')}
                maxLength={64}
                className="w-full text-xs px-3 py-2 bg-black/30 border border-hxa-border rounded-lg text-hxa-text placeholder:text-hxa-text-muted focus:outline-none focus:border-hxa-accent/50"
              />
            </div>

            {/* Invite button */}
            <button
              onClick={handleInvite}
              disabled={inviting}
              className="w-full text-xs font-medium px-4 py-2 bg-hxa-accent/20 text-hxa-accent border border-hxa-accent/30 rounded-lg hover:bg-hxa-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {inviting ? '...' : t('thread.inviteBot.invite')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
