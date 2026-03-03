'use client';

import { useState, useRef, useEffect } from 'react';
import { User, Clock, FileText, X, ChevronDown, Circle } from 'lucide-react';
import { cn, formatTime, statusColor, STATUS_TRANSITIONS } from '@/lib/utils';
import type { ThreadStatus } from '@/lib/types';

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
}: ThreadHeaderProps) {
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
              {status}
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
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

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
                  <span className="text-xs font-semibold text-hxa-text">Participants ({participantCount})</span>
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
                  <p className="text-xs text-hxa-text-muted">No participant details available</p>
                )}
              </div>
            )}
          </div>

          <span className="text-[11px] text-hxa-text-muted flex items-center gap-1">
            <Clock size={10} /> {formatTime(createdAt)}
          </span>
        </div>
      </div>

      {onOpenArtifacts && (
        <button
          onClick={onOpenArtifacts}
          className="text-xs text-hxa-accent border border-hxa-accent/30 px-2.5 py-1.5 rounded-md hover:bg-hxa-accent/10 transition-colors flex items-center gap-1"
        >
          <FileText size={12} /> Artifacts
        </button>
      )}
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
