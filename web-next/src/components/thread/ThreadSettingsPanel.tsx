'use client';

import { useState, useEffect } from 'react';
import { X, Shield, Plus } from 'lucide-react';
import { useTranslations } from '@/i18n/context';

const VISIBILITY_OPTIONS = ['public', 'members', 'private'] as const;
const JOIN_POLICY_OPTIONS = ['open', 'approval', 'invite_only'] as const;
const PERMISSION_ACTIONS = ['resolve', 'close', 'write', 'invite', 'remove', 'manage'] as const;

interface ThreadSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  visibility?: 'public' | 'members' | 'private';
  joinPolicy?: 'open' | 'approval' | 'invite_only';
  permissionPolicy?: Record<string, string[] | null> | null;
  onSave: (updates: {
    visibility?: string;
    join_policy?: string;
    permission_policy?: Record<string, string[] | null> | null;
  }) => void;
  saving?: boolean;
}

export function ThreadSettingsPanel({
  open,
  onClose,
  visibility: initialVisibility,
  joinPolicy: initialJoinPolicy,
  permissionPolicy: initialPermPolicy,
  onSave,
  saving,
}: ThreadSettingsPanelProps) {
  const { t } = useTranslations();
  const [visibility, setVisibility] = useState<string>(initialVisibility ?? 'public');
  const [joinPolicy, setJoinPolicy] = useState<string>(initialJoinPolicy ?? 'open');
  const [permPolicy, setPermPolicy] = useState<Record<string, string[]>>({});
  const [newLabelInputs, setNewLabelInputs] = useState<Record<string, string>>({});

  // Sync from props when panel opens
  useEffect(() => {
    if (open) {
      setVisibility(initialVisibility ?? 'public');
      setJoinPolicy(initialJoinPolicy ?? 'open');
      // Parse permission policy — may be a JSON string or object
      let parsed: Record<string, string[] | null> = {};
      if (initialPermPolicy) {
        if (typeof initialPermPolicy === 'string') {
          try { parsed = JSON.parse(initialPermPolicy); } catch { parsed = {}; }
        } else {
          parsed = initialPermPolicy as Record<string, string[] | null>;
        }
      }
      const normalized: Record<string, string[]> = {};
      for (const action of PERMISSION_ACTIONS) {
        normalized[action] = parsed[action] ?? [];
      }
      setPermPolicy(normalized);
      setNewLabelInputs({});
    }
  }, [open, initialVisibility, initialJoinPolicy, initialPermPolicy]);

  if (!open) return null;

  function handleAddLabel(action: string) {
    const label = (newLabelInputs[action] ?? '').trim();
    if (!label) return;
    setPermPolicy(prev => {
      const current = prev[action] ?? [];
      if (current.includes(label)) return prev;
      return { ...prev, [action]: [...current, label] };
    });
    setNewLabelInputs(prev => ({ ...prev, [action]: '' }));
  }

  function handleRemoveLabel(action: string, label: string) {
    setPermPolicy(prev => ({
      ...prev,
      [action]: (prev[action] ?? []).filter(l => l !== label),
    }));
  }

  function handleSave() {
    // Build permission_policy — only include actions with labels
    const pp: Record<string, string[] | null> = {};
    let hasAny = false;
    for (const action of PERMISSION_ACTIONS) {
      const labels = permPolicy[action] ?? [];
      if (labels.length > 0) {
        pp[action] = labels;
        hasAny = true;
      }
    }
    onSave({
      visibility,
      join_policy: joinPolicy,
      permission_policy: hasAny ? pp : null,
    });
  }

  return (
    <div className="w-[360px] shrink-0 border-l border-hxa-border bg-[rgba(10,15,26,0.6)] flex flex-col max-md:fixed max-md:inset-0 max-md:w-full max-md:z-[1000] max-md:bg-[#0a0f1a]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-hxa-border shrink-0">
        <h3 className="text-sm font-semibold text-hxa-text flex items-center gap-1.5">
          <Shield size={14} className="text-hxa-accent" />
          {t('thread.settings')}
        </h3>
        <button onClick={onClose} className="text-hxa-text-dim hover:text-hxa-text p-1 transition-colors">
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 min-h-0">
        {/* Visibility */}
        <div>
          <label className="text-xs font-semibold text-hxa-text-dim uppercase tracking-wider mb-2 block">
            {t('thread.visibility')}
          </label>
          <div className="flex gap-2">
            {VISIBILITY_OPTIONS.map(opt => (
              <button
                key={opt}
                onClick={() => {
                  setVisibility(opt);
                  // Private forces invite_only
                  if (opt === 'private') setJoinPolicy('invite_only');
                }}
                className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors ${
                  visibility === opt
                    ? 'bg-hxa-accent/20 text-hxa-accent border-hxa-accent/40'
                    : 'bg-black/20 text-hxa-text-dim border-hxa-border hover:border-hxa-text-dim'
                }`}
              >
                {t(`thread.visibility.${opt}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Join Policy */}
        <div>
          <label className="text-xs font-semibold text-hxa-text-dim uppercase tracking-wider mb-2 block">
            {t('thread.joinPolicy')}
          </label>
          <div className="flex gap-2">
            {JOIN_POLICY_OPTIONS.map(opt => {
              const disabled = visibility === 'private' && opt !== 'invite_only';
              return (
                <button
                  key={opt}
                  onClick={() => !disabled && setJoinPolicy(opt)}
                  disabled={disabled}
                  className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors ${
                    joinPolicy === opt
                      ? 'bg-hxa-accent/20 text-hxa-accent border-hxa-accent/40'
                      : disabled
                      ? 'bg-black/10 text-hxa-text-muted border-hxa-border/50 cursor-not-allowed opacity-50'
                      : 'bg-black/20 text-hxa-text-dim border-hxa-border hover:border-hxa-text-dim'
                  }`}
                >
                  {t(`thread.joinPolicy.${opt}`)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Permission Policy */}
        <div>
          <label className="text-xs font-semibold text-hxa-text-dim uppercase tracking-wider mb-3 block">
            {t('thread.permissions')}
          </label>
          <div className="space-y-3">
            {PERMISSION_ACTIONS.map(action => {
              const labels = permPolicy[action] ?? [];
              return (
                <div key={action} className="border border-hxa-border rounded-lg p-2.5 bg-black/20">
                  <div className="text-xs font-medium text-hxa-text mb-1.5">
                    {t(`thread.permissions.${action}`)}
                  </div>
                  {/* Labels */}
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {labels.length === 0 && (
                      <span className="text-[10px] text-hxa-text-muted italic">{t('thread.permissions.unrestricted')}</span>
                    )}
                    {labels.map(label => (
                      <span
                        key={label}
                        className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded ${
                          label === '*'
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : label === 'initiator'
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : 'bg-hxa-accent/10 text-hxa-accent border border-hxa-accent/20'
                        }`}
                      >
                        {label === '*' ? t('thread.permissions.anyParticipant') : label === 'initiator' ? t('thread.permissions.initiatorOnly') : label}
                        <button
                          onClick={() => handleRemoveLabel(action, label)}
                          className="hover:text-hxa-text ml-0.5"
                        >
                          <X size={8} />
                        </button>
                      </span>
                    ))}
                  </div>
                  {/* Add label input */}
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={newLabelInputs[action] ?? ''}
                      onChange={e => setNewLabelInputs(prev => ({ ...prev, [action]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddLabel(action); } }}
                      placeholder={t('thread.permissions.addLabel')}
                      maxLength={64}
                      className="flex-1 text-[11px] px-2 py-1 bg-black/30 border border-hxa-border rounded text-hxa-text placeholder:text-hxa-text-muted focus:outline-none focus:border-hxa-accent/50"
                    />
                    <button
                      onClick={() => handleAddLabel(action)}
                      className="text-hxa-accent hover:bg-hxa-accent/10 p-1 rounded transition-colors"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer — save button */}
      <div className="shrink-0 px-4 py-3 border-t border-hxa-border">
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full text-xs font-medium px-4 py-2 bg-hxa-accent/20 text-hxa-accent border border-hxa-accent/30 rounded-lg hover:bg-hxa-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? '...' : t('org.settings.save')}
        </button>
      </div>
    </div>
  );
}
