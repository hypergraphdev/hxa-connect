'use client';

import { useState, useRef, useEffect } from 'react';
import { User, Clock, FileText, X, ChevronDown, Circle, Eye, EyeOff, Users, Settings, UserPlus } from 'lucide-react';
import { cn, formatTime, statusColor, STATUS_TRANSITIONS } from '@/lib/utils';
import type { ThreadStatus } from '@/lib/types';
import { useTranslations } from '@/i18n/context';

export interface ThreadParticipantInfo {
  id: string;
  name: string;
  online?: boolean;
  label?: string;
}

export interface ThreadHeaderProps {
  topic: string;
  status: ThreadStatus;
  participantCount: number;
  participants?: ThreadParticipantInfo[];
  createdAt: string;
  /** Whether the user can change thread status */
  canChangeStatus: boolean;
  /** Called when user selects a new status */
  onStatusChange?: (status: string, closeReason?: string) => void;
  /** Called to open artifacts panel/view */
  onOpenArtifacts?: () => void;
  visibility?: 'public' | 'members' | 'private';
  /** Whether user can manage thread settings */
  canManageSettings?: boolean;
  /** Called to open thread settings panel */
  onOpenSettings?: () => void;
  /** Called to invite a bot */
  onInviteBot?: () => void;
}

export function ThreadHeader({
  topic,
  status,
  participantCount,
  participants,
  createdAt,
  canChangeStatus,
  onStatusChange,
  onOpenArtifacts,
  visibility,
  canManageSettings,
  onOpenSettings,
  onInviteBot,
}: ThreadHeaderProps) {
  const { t } = useTranslations();
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const participantsRef = useRef<HTMLDivElement>(null);

  const allowedTransitions = STATUS_TRANSITIONS[status] || [];

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setStatusDropdownOpen(false);
      }
      if (participantsRef.current && !participantsRef.current.contains(e.target as Node)) {
        setParticipantsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleTransition(newStatus: string) {
    setStatusDropdownOpen(false);
    if (newStatus === 'closed') {
      onStatusChange?.(newStatus, 'manual');
    } else {
      onStatusChange?.(newStatus);
    }
  }

  return (
    <div className="shrink-0 px-4 py-3 border-b border-hxa-border bg-[rgba(10,15,26,0.4)] flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <h2 className="text-sm font-semibold text-hxa-text truncate" title={topic}>{topic}</h2>
        <div className="flex items-center gap-2 mt-0.5">
          {/* Status badge — clickable dropdown if allowed */}
          <div className="relative" ref={statusRef}>
            <button
              onClick={() => {
                if (canChangeStatus && allowedTransitions.length > 0) {
                  setStatusDropdownOpen(!statusDropdownOpen);
                }
              }}
              className={cn(
                'text-[10px] font-semibold px-1.5 py-0.5 rounded border inline-flex items-center gap-1',
                statusColor(status),
                canChangeStatus && allowedTransitions.length > 0 && 'cursor-pointer hover:brightness-125',
                (!canChangeStatus || allowedTransitions.length === 0) && 'cursor-default',
              )}
            >
              {t(`thread.status.${status}`)}
              {canChangeStatus && allowedTransitions.length > 0 && <ChevronDown size={8} />}
            </button>
            {statusDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-[#0d1a2d] border border-hxa-border rounded-lg shadow-xl py-1 min-w-[120px]">
                {allowedTransitions.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleTransition(s)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-hxa-bg-hover transition-colors flex items-center gap-2"
                  >
                    <span className={cn('w-2 h-2 rounded-full', statusDot(s))} />
                    {t(`thread.status.${s}`)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Visibility badge */}
          {visibility && (
            <span className={cn(
              'text-[10px] font-medium px-1.5 py-0.5 rounded border inline-flex items-center gap-1',
              visibility === 'public' && 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
              visibility === 'members' && 'text-amber-400 border-amber-500/30 bg-amber-500/10',
              visibility === 'private' && 'text-rose-400 border-rose-500/30 bg-rose-500/10',
            )}>
              {visibility === 'public' && <Eye size={9} />}
              {visibility === 'members' && <Users size={9} />}
              {visibility === 'private' && <EyeOff size={9} />}
              {t(`thread.visibility.${visibility}`)}
            </span>
          )}

          {/* Participants — clickable to show popup */}
          <div className="relative" ref={participantsRef}>
            <button
              onClick={() => setParticipantsOpen(!participantsOpen)}
              className="text-[11px] text-hxa-text-muted flex items-center gap-1 hover:text-hxa-text transition-colors"
            >
              <User size={10} /> {participantCount}
            </button>
            {participantsOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-[#0d1a2d] border border-hxa-border rounded-lg shadow-xl py-2 px-3 min-w-[180px] max-w-[260px]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-hxa-text">{t('thread.participants', { count: participantCount })}</span>
                  <button onClick={() => setParticipantsOpen(false)} className="text-hxa-text-muted hover:text-hxa-text">
                    <X size={12} />
                  </button>
                </div>
                {participants && participants.length > 0 ? (
                  <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {participants.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 text-xs">
                        <Circle
                          size={6}
                          className={cn(
                            'shrink-0',
                            p.online ? 'fill-emerald-400 text-emerald-400' : 'fill-hxa-text-dim text-hxa-text-dim',
                          )}
                        />
                        <span className="text-hxa-text truncate">{p.name}</span>
                        {p.label && <span className="text-[9px] text-hxa-text-muted ml-auto">{p.label}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-hxa-text-muted">{t('thread.noParticipants')}</p>
                )}
              </div>
            )}
          </div>

          <span className="text-[11px] text-hxa-text-muted flex items-center gap-1">
            <Clock size={10} /> {formatTime(createdAt, t)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {onInviteBot && (
          <button
            onClick={onInviteBot}
            className="text-xs text-hxa-text-muted border border-hxa-border px-2 py-1.5 rounded-md hover:bg-white/[0.04] hover:text-hxa-text transition-colors flex items-center gap-1"
            title={t('thread.inviteBot')}
          >
            <UserPlus size={12} />
          </button>
        )}

        {canManageSettings && onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="text-xs text-hxa-text-muted border border-hxa-border px-2 py-1.5 rounded-md hover:bg-white/[0.04] hover:text-hxa-text transition-colors flex items-center gap-1"
            title={t('thread.settings')}
          >
            <Settings size={12} />
          </button>
        )}

        {onOpenArtifacts && (
          <button
            onClick={onOpenArtifacts}
            className="text-xs text-hxa-accent border border-hxa-accent/30 px-2.5 py-1.5 rounded-md hover:bg-hxa-accent/10 transition-colors flex items-center gap-1"
          >
            <FileText size={12} /> {t('thread.artifacts')}
          </button>
        )}
      </div>
    </div>
  );
}

function statusDot(status: string): string {
  const map: Record<string, string> = {
    active: 'bg-emerald-400',
    blocked: 'bg-amber-400',
    reviewing: 'bg-purple-400',
    resolved: 'bg-slate-400',
    closed: 'bg-rose-400',
  };
  return map[status] ?? 'bg-slate-400';
}
