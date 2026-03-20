'use client';

import { useState, useEffect } from 'react';
import { X, Shield, Plus } from 'lucide-react';
import { useTranslations } from '@/i18n/context';

const VISIBILITY_OPTIONS = ['public', 'members', 'private'] as const;
const JOIN_POLICY_OPTIONS = ['open', 'approval', 'invite_only'] as const;
const PERMISSION_ACTIONS = ['resolve', 'close', 'write', 'invite', 'remove', 'manage'] as const;
const MAX_CUSTOM_LABELS = 5;

// Permission mode: determines how labels are resolved
type PermMode = 'unrestricted' | 'initiator' | 'everyone' | 'custom';

function getMode(labels: string[]): PermMode {
  if (labels.length === 0) return 'unrestricted';
  if (labels.length === 1 && labels[0] === 'initiator') return 'initiator';
  if (labels.length === 1 && labels[0] === '*') return 'everyone';
  return 'custom';
}

function labelsForMode(mode: PermMode, customLabels: string[]): string[] {
  if (mode === 'unrestricted') return [];
  if (mode === 'initiator') return ['initiator'];
  if (mode === 'everyone') return ['*'];
  return customLabels;
}

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
  /** When true, show current settings as read-only (no editing, no save button). */
  readOnly?: boolean;
}

export function ThreadSettingsPanel({
  open,
  onClose,
  visibility: initialVisibility,
  joinPolicy: initialJoinPolicy,
  permissionPolicy: initialPermPolicy,
  onSave,
  saving,
  readOnly,
}: ThreadSettingsPanelProps) {
  const { t } = useTranslations();
  const [visibility, setVisibility] = useState<string>(initialVisibility ?? 'public');
  const [joinPolicy, setJoinPolicy] = useState<string>(initialJoinPolicy ?? 'open');
  const [permModes, setPermModes] = useState<Record<string, PermMode>>({});
  const [customLabels, setCustomLabels] = useState<Record<string, string[]>>({});
  const [newLabelInputs, setNewLabelInputs] = useState<Record<string, string>>({});

  // Sync from props when panel opens
  useEffect(() => {
    if (open) {
      setVisibility(initialVisibility ?? 'public');
      setJoinPolicy(initialJoinPolicy ?? 'open');
      let parsed: Record<string, string[] | null> = {};
      if (initialPermPolicy) {
        if (typeof initialPermPolicy === 'string') {
          try { parsed = JSON.parse(initialPermPolicy); } catch { parsed = {}; }
        } else {
          parsed = initialPermPolicy as Record<string, string[] | null>;
        }
      }
      const modes: Record<string, PermMode> = {};
      const customs: Record<string, string[]> = {};
      for (const action of PERMISSION_ACTIONS) {
        const labels = parsed[action] ?? [];
        modes[action] = getMode(labels);
        // For custom mode, keep all labels; for presets that were customized, preserve custom labels
        customs[action] = labels.filter(l => l !== '*' && l !== 'initiator');
      }
      setPermModes(modes);
      setCustomLabels(customs);
      setNewLabelInputs({});
    }
  }, [open, initialVisibility, initialJoinPolicy, initialPermPolicy]);

  if (!open) return null;

  function handleModeChange(action: string, mode: PermMode) {
    setPermModes(prev => ({ ...prev, [action]: mode }));
  }

  function handleAddCustomLabel(action: string) {
    const label = (newLabelInputs[action] ?? '').trim();
    if (!label) return;
    setCustomLabels(prev => {
      const current = prev[action] ?? [];
      if (current.length >= MAX_CUSTOM_LABELS) return prev;
      if (current.includes(label) || label === '*' || label === 'initiator') return prev;
      return { ...prev, [action]: [...current, label] };
    });
    setNewLabelInputs(prev => ({ ...prev, [action]: '' }));
    // Auto-switch to custom mode when adding labels
    setPermModes(prev => ({ ...prev, [action]: 'custom' }));
  }

  function handleRemoveCustomLabel(action: string, label: string) {
    setCustomLabels(prev => {
      const updated = (prev[action] ?? []).filter(l => l !== label);
      return { ...prev, [action]: updated };
    });
  }

  function handleSave() {
    const pp: Record<string, string[] | null> = {};
    let hasAny = false;
    for (const action of PERMISSION_ACTIONS) {
      const mode = permModes[action] ?? 'unrestricted';
      let labels = labelsForMode(mode, customLabels[action] ?? []);
      // manage "unrestricted" must emit ["*"] because the backend defaults
      // undefined manage to initiator-only (safe default), unlike other actions
      if (action === 'manage' && mode === 'unrestricted') labels = ['*'];
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

  const MODE_OPTIONS: { value: PermMode; labelKey: string }[] = [
    { value: 'unrestricted', labelKey: 'thread.permissions.unrestricted' },
    { value: 'everyone', labelKey: 'thread.permissions.anyParticipant' },
    { value: 'initiator', labelKey: 'thread.permissions.initiatorOnly' },
    { value: 'custom', labelKey: 'thread.permissions.custom' },
  ];

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
                  if (readOnly) return;
                  setVisibility(opt);
                  if (opt === 'private') setJoinPolicy('invite_only');
                }}
                disabled={readOnly}
                className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors ${
                  visibility === opt
                    ? 'bg-hxa-accent/20 text-hxa-accent border-hxa-accent/40'
                    : readOnly
                    ? 'bg-black/10 text-hxa-text-muted border-hxa-border/50 cursor-not-allowed opacity-50'
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
              const isDisabled = readOnly || (visibility === 'private' && opt !== 'invite_only');
              return (
                <button
                  key={opt}
                  onClick={() => !isDisabled && setJoinPolicy(opt)}
                  disabled={isDisabled}
                  className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors ${
                    joinPolicy === opt
                      ? 'bg-hxa-accent/20 text-hxa-accent border-hxa-accent/40'
                      : isDisabled
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

        {/* Permission Policy — hidden in read-only mode */}
        {!readOnly && <div>
          <label className="text-xs font-semibold text-hxa-text-dim uppercase tracking-wider mb-3 block">
            {t('thread.permissions')}
          </label>
          <div className="space-y-3">
            {PERMISSION_ACTIONS.map(action => {
              const mode = permModes[action] ?? 'unrestricted';
              const customs = customLabels[action] ?? [];
              return (
                <div key={action} className="border border-hxa-border rounded-lg p-2.5 bg-black/20">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-hxa-text">
                      {t(`thread.permissions.${action}`)}
                    </span>
                  </div>

                  {/* Preset mode buttons */}
                  <div className="flex flex-wrap gap-1 mb-2">
                    {MODE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => handleModeChange(action, opt.value)}
                        className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                          mode === opt.value
                            ? opt.value === 'everyone' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                            : opt.value === 'initiator' ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                            : opt.value === 'custom' ? 'bg-hxa-accent/20 text-hxa-accent border-hxa-accent/40'
                            : 'bg-slate-500/20 text-slate-400 border-slate-500/40'
                            : 'bg-black/20 text-hxa-text-muted border-hxa-border hover:border-hxa-text-dim'
                        }`}
                      >
                        {t(opt.labelKey)}
                      </button>
                    ))}
                  </div>

                  {/* Custom labels section — only shown in custom mode */}
                  {mode === 'custom' && (
                    <div className="mt-1.5">
                      {/* Existing custom labels */}
                      {customs.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-1.5">
                          {customs.map(label => (
                            <span
                              key={label}
                              className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-hxa-accent/10 text-hxa-accent border border-hxa-accent/20"
                            >
                              {label}
                              <button
                                onClick={() => handleRemoveCustomLabel(action, label)}
                                className="hover:text-hxa-text ml-0.5"
                              >
                                <X size={8} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Add custom label */}
                      {customs.length < MAX_CUSTOM_LABELS && (
                        <div className="flex gap-1">
                          <input
                            type="text"
                            value={newLabelInputs[action] ?? ''}
                            onChange={e => setNewLabelInputs(prev => ({ ...prev, [action]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustomLabel(action); } }}
                            placeholder={t('thread.permissions.addLabel')}
                            maxLength={64}
                            className="flex-1 text-[11px] px-2 py-1 bg-black/30 border border-hxa-border rounded text-hxa-text placeholder:text-hxa-text-muted focus:outline-none focus:border-hxa-accent/50"
                          />
                          <button
                            onClick={() => handleAddCustomLabel(action)}
                            className="text-hxa-accent hover:bg-hxa-accent/10 p-1 rounded transition-colors"
                          >
                            <Plus size={12} />
                          </button>
                        </div>
                      )}
                      {customs.length >= MAX_CUSTOM_LABELS && (
                        <span className="text-[10px] text-hxa-text-muted">{t('thread.permissions.maxLabels', { max: MAX_CUSTOM_LABELS })}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>}
      </div>

      {/* Footer — save button (hidden in read-only mode) */}
      {!readOnly && (
        <div className="shrink-0 px-4 py-3 border-t border-hxa-border">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full text-xs font-medium px-4 py-2 bg-hxa-accent/20 text-hxa-accent border border-hxa-accent/30 rounded-lg hover:bg-hxa-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? '...' : t('org.settings.save')}
          </button>
        </div>
      )}
    </div>
  );
}
