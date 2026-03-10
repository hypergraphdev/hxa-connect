'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Shield, Building2, KeyRound, Plus, RotateCw, Eye,
  Pause, Play, Trash2, Copy, X, ArrowLeft, LogOut, Bot,
} from 'lucide-react';
import { superAdmin, type Org, type InviteCode, AdminApiError } from '@/lib/admin-api';
import * as api from '@/lib/api';
import { useTranslations } from '@/i18n/context';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// ─── Shared UI ───

function Toast({ message, type, onDone }: { message: string; type: 'success' | 'error'; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg animate-fade-in ${
      type === 'success' ? 'bg-hxa-green/20 text-hxa-green border border-hxa-green/30' : 'bg-hxa-red/20 text-hxa-red border border-hxa-red/30'
    }`}>
      {message}
    </div>
  );
}

function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel, typeTo }: {
  title: string; message: string; confirmLabel: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void; typeTo?: string;
}) {
  const { t } = useTranslations();
  const [typed, setTyped] = useState('');
  const canConfirm = !typeTo || typed === typeTo;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-hxa-text-dim text-sm mb-4">{message}</p>
        {typeTo && (
          <input
            type="text"
            placeholder={t('admin.confirm.typeTo', { value: typeTo })}
            value={typed}
            onChange={e => setTyped(e.target.value)}
            className="w-full bg-black/30 border border-hxa-border rounded-lg px-3 py-2 text-sm font-mono mb-4 outline-none focus:border-hxa-accent"
          />
        )}
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-hxa-text-dim hover:text-hxa-text transition-colors">
            {t('admin.confirm.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-40 ${
              danger ? 'bg-hxa-red/20 text-hxa-red hover:bg-hxa-red/30 border border-hxa-red/30' : 'bg-hxa-accent/20 text-hxa-accent hover:bg-hxa-accent/30 border border-hxa-accent/30'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function SecretModal({ title, subtitle, orgId, secret, hint, onClose }: {
  title: string; subtitle?: string; orgId?: string; secret: string; hint?: string; onClose: () => void;
}) {
  const { t } = useTranslations();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!orgId); // auto-reveal for simple secret modals (rotate)

  const copyText = orgId ? `org id: ${orgId}\norg secret: ${secret}` : secret;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-hxa-text-dim hover:text-hxa-text"><X size={18} /></button>
        </div>
        {subtitle && <p className="text-hxa-text-dim text-sm mb-4">{subtitle}</p>}
        {orgId && (
          <div className="mb-3">
            <label className="text-xs text-hxa-text-dim mb-1 block">{t('admin.secret.orgId')}</label>
            <div className="bg-black/30 border border-hxa-border rounded-lg px-3 py-2 font-mono text-sm text-hxa-accent break-all select-all">
              {orgId}
            </div>
          </div>
        )}
        <div className="mb-1">
          <label className="text-xs text-hxa-text-dim mb-1 block">{orgId ? t('admin.secret.orgSecret') : t('admin.secret.secret')}</label>
          <div className="flex items-center gap-2 bg-[rgba(239,68,68,0.06)] border border-[rgba(239,68,68,0.15)] rounded-lg px-3 py-2">
            <span className="flex-1 font-mono text-sm break-all text-red-400 select-all">
              {revealed ? secret : '\u2022'.repeat(secret.length)}
            </span>
            <button
              onClick={() => setRevealed(!revealed)}
              className="text-xs text-hxa-text-dim hover:text-hxa-text whitespace-nowrap transition-colors"
            >
              {revealed ? t('admin.secret.hide') : t('admin.secret.show')}
            </button>
          </div>
        </div>
        {hint && <p className="text-hxa-text-dim text-[11px] mb-4">{hint}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm text-hxa-text-dim hover:text-hxa-text border border-hxa-border rounded-lg transition-colors">
            {t('admin.secret.done')}
          </button>
          <button
            onClick={() => { navigator.clipboard.writeText(copyText); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-hxa-accent/20 text-hxa-accent rounded-lg hover:bg-hxa-accent/30 transition-colors text-sm font-medium border border-hxa-accent/30"
          >
            <Copy size={14} /> {copied ? t('admin.secret.copied') : orgId ? t('admin.secret.copyCredentials') : t('admin.secret.copyClipboard')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Copyable Code (hover to copy) ───

function CopyableCode({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslations();
  return (
    <span className="group inline-flex items-center gap-1.5 font-mono text-xs text-hxa-accent">
      <span className="select-all">{display ?? value}</span>
      <button
        onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-hxa-text-dim hover:text-hxa-accent"
        title={t('common.copy')}
      >
        {copied ? <span className="text-hxa-green text-[10px]">{t('common.copied')}</span> : <Copy size={12} />}
      </button>
    </span>
  );
}

// ─── Status Badge ───

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslations();
  const colors: Record<string, string> = {
    active: 'bg-hxa-green/20 text-hxa-green border-hxa-green/30',
    suspended: 'bg-hxa-amber/20 text-hxa-amber border-hxa-amber/30',
    destroyed: 'bg-hxa-red/20 text-hxa-red border-hxa-red/30',
  };
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${colors[status] ?? 'bg-hxa-text-dim/20 text-hxa-text-dim border-hxa-text-dim/30'}`}>
      {t(`admin.orgStatus.${status}`)}
    </span>
  );
}

// ─── Main Page ───

export default function AdminPage() {
  const router = useRouter();
  const { t } = useTranslations();
  const [inputSecret, setInputSecret] = useState('');
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [orgs, setOrgs] = useState<Org[]>([]);
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [confirm, setConfirm] = useState<Parameters<typeof ConfirmDialog>[0] | null>(null);
  const [secretModal, setSecretModal] = useState<{ title: string; subtitle?: string; orgId?: string; secret: string; hint?: string } | null>(null);
  const [selectedOrg, setSelectedOrg] = useState<Org | null>(null);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [showCreateCode, setShowCreateCode] = useState(false);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  }, []);

  // Check existing session on mount
  useEffect(() => {
    api.getSession()
      .then(session => {
        if (session.role === 'super_admin') {
          superAdmin.listOrgs()
            .then(data => { setOrgs(data); setAuthed(true); })
            .catch(() => {})
            .finally(() => setLoginLoading(false));
        } else {
          setLoginLoading(false);
        }
      })
      .catch(() => setLoginLoading(false));
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [orgData, codeData] = await Promise.all([
        superAdmin.listOrgs(),
        superAdmin.listInviteCodes(),
      ]);
      setOrgs(orgData);
      setInviteCodes(codeData);
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        setAuthed(false);
      }
    }
  }, []);

  // Load invite codes after auth
  useEffect(() => {
    if (authed) {
      superAdmin.listInviteCodes().then(setInviteCodes).catch(() => {});
    }
  }, [authed]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    setSubmitting(true);
    try {
      await fetch(`${BASE_PATH}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'super_admin', admin_secret: inputSecret }),
      }).then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new AdminApiError(res.status, body.error ?? 'Login failed');
        }
      });
      const data = await superAdmin.listOrgs();
      setOrgs(data);
      setAuthed(true);
    } catch (err) {
      setLoginError(err instanceof AdminApiError ? err.message : t('login.error.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    await api.logout();
    setAuthed(false);
    setInputSecret('');
    setOrgs([]);
    setInviteCodes([]);
  }

  // ─── Login Screen ───
  if (loginLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-3 border-hxa-accent/20 border-t-hxa-accent animate-spin" />
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-5 p-4">
        <div className="flex flex-col items-center gap-3 mb-2">
          <img src={`${BASE_PATH}/images/logo.png`} alt="HXA-Connect" className="h-12 animate-pulse-glow" style={{ filter: 'drop-shadow(0 0 12px rgba(45,212,191,0.6))' }} />
          <h1 className="text-2xl font-bold gradient-text">{t('admin.title')}</h1>
          <p className="text-hxa-text-dim text-sm">{t('admin.subtitle')}</p>
        </div>
        <form onSubmit={handleLogin} className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-8 w-full max-w-[400px] flex flex-col gap-4 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          <input
            type="password"
            placeholder={t('admin.placeholder.secret')}
            value={inputSecret}
            onChange={e => setInputSecret(e.target.value)}
            className="bg-black/30 border border-hxa-border rounded-lg px-4 py-3 text-hxa-text font-mono text-sm outline-none focus:border-hxa-accent w-full"
          />
          {loginError && <p className="text-hxa-red text-sm text-center">{loginError}</p>}
          <button type="submit" disabled={submitting} className="gradient-btn rounded-lg py-3 text-sm font-bold cursor-pointer disabled:opacity-50">
            {submitting ? t('admin.button.connecting') : t('admin.button.signIn')}
          </button>
        </form>
        <button onClick={() => router.push('/')} className="text-hxa-text-dim text-sm hover:text-hxa-accent transition-colors flex items-center gap-1">
          <ArrowLeft size={14} /> {t('admin.backToLogin')}
        </button>
      </div>
    );
  }

  // ─── Org Detail View ───
  if (selectedOrg) {
    return (
      <div className="fixed inset-0 overflow-auto p-4 md:p-8">
        {toast && <Toast {...toast} onDone={() => setToast(null)} />}
        {secretModal && <SecretModal {...secretModal} onClose={() => setSecretModal(null)} />}
        <div className="max-w-4xl mx-auto">
          <button onClick={() => setSelectedOrg(null)} className="flex items-center gap-1.5 text-hxa-text-dim hover:text-hxa-accent text-sm mb-6 transition-colors">
            <ArrowLeft size={16} /> {t('admin.backToOrgs')}
          </button>
          <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-6">
            <div className="flex items-center gap-3 mb-6">
              <Building2 size={24} className="text-hxa-accent" />
              <h2 className="text-xl font-bold">{selectedOrg.name}</h2>
              <StatusBadge status={selectedOrg.status} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div><span className="text-hxa-text-dim">{t('admin.orgDetail.id')}</span> <span className="font-mono text-hxa-accent">{selectedOrg.id}</span></div>
              <div><span className="text-hxa-text-dim">{t('admin.orgDetail.status')}</span> {selectedOrg.status}</div>
              <div><span className="text-hxa-text-dim">{t('admin.orgDetail.bots')}</span> {selectedOrg.bot_count}</div>
              <div><span className="text-hxa-text-dim">{t('admin.orgDetail.created')}</span> {new Date(selectedOrg.created_at).toLocaleDateString()}</div>
            </div>
            {selectedOrg.org_secret && (
              <div className="mt-4 p-3 bg-black/30 border border-hxa-border rounded-lg">
                <span className="text-hxa-text-dim text-xs">{t('admin.orgDetail.secret')}</span>
                <span className="font-mono text-sm ml-2 text-hxa-accent">{selectedOrg.org_secret.slice(0, 8)}...</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Main Console ───
  const totalBots = orgs.reduce((sum, o) => sum + (o.bot_count || 0), 0);

  return (
    <div className="fixed inset-0 overflow-auto">
      {toast && <Toast {...toast} onDone={() => setToast(null)} />}
      {confirm && <ConfirmDialog {...confirm} />}
      {secretModal && <SecretModal {...secretModal} onClose={() => setSecretModal(null)} />}
      {showCreateOrg && <CreateOrgModal onClose={() => setShowCreateOrg(false)} onCreated={(name, orgId, orgSecret) => {
        setShowCreateOrg(false);
        loadData();
        setSecretModal({ title: t('admin.orgCreated.title'), subtitle: t('admin.orgCreated.subtitle', { name }), orgId, secret: orgSecret, hint: t('admin.secretHint') });
      }} />}
      {showCreateCode && <CreateCodeModal onClose={() => setShowCreateCode(false)} onCreated={(code) => {
        setShowCreateCode(false);
        loadData();
        setSecretModal({ title: t('admin.codeCreated.title'), secret: code, hint: t('admin.codeHint') });
      }} />}

      {/* Header */}
      <header className="border-b border-hxa-border bg-[rgba(10,15,26,0.8)] glass sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={`${BASE_PATH}/images/logo.png`} alt="HXA-Connect" className="h-6" />
            <span className="font-semibold">HXA-Connect</span>
            <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-hxa-accent/20 text-hxa-accent rounded border border-hxa-accent/30">
              {t('admin.badge.superAdmin')}
            </span>
          </div>
          <button onClick={() => setConfirm({
            title: t('admin.logoutTitle'),
            message: t('admin.logoutMessage'),
            confirmLabel: t('admin.logoutConfirm'),
            danger: true,
            onConfirm: () => { setConfirm(null); handleLogout(); },
            onCancel: () => setConfirm(null),
          })} className="flex items-center gap-1.5 text-hxa-text-dim hover:text-hxa-red text-sm transition-colors">
            <LogOut size={14} /> {t('admin.logout')}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-8 py-6 space-y-8">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[
            { label: t('admin.stat.organizations'), value: orgs.length, icon: Building2 },
            { label: t('admin.stat.active'), value: orgs.filter(o => o.status === 'active').length, icon: Play },
            { label: t('admin.stat.suspended'), value: orgs.filter(o => o.status === 'suspended').length, icon: Pause },
            { label: t('admin.stat.totalBots'), value: totalBots, icon: Bot },
            { label: t('admin.stat.inviteCodes'), value: inviteCodes.length, icon: KeyRound },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4 text-center">
              <Icon size={16} className="text-hxa-accent mx-auto mb-1.5" />
              <div className="text-2xl font-bold text-hxa-accent">{value}</div>
              <div className="text-xs text-hxa-text-dim uppercase tracking-wider">{label}</div>
            </div>
          ))}
        </div>

        {/* Organizations */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{t('admin.section.organizations')}</h2>
            <button onClick={() => setShowCreateOrg(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-hxa-accent/20 text-hxa-accent rounded-lg hover:bg-hxa-accent/30 border border-hxa-accent/30 transition-colors">
              <Plus size={14} /> {t('admin.createOrg')}
            </button>
          </div>
          <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl overflow-hidden">
            <div className="max-h-[40vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[#0a0f1a] z-[1]">
                <tr className="border-b border-hxa-border text-hxa-text-dim text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-3">{t('admin.table.name')}</th>
                  <th className="text-left px-4 py-3">{t('admin.table.id')}</th>
                  <th className="text-left px-4 py-3">{t('admin.table.status')}</th>
                  <th className="text-left px-4 py-3">{t('admin.table.bots')}</th>
                  <th className="text-left px-4 py-3">{t('admin.table.created')}</th>
                  <th className="text-right px-4 py-3">{t('admin.table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map(org => (
                  <tr key={org.id} className="border-b border-hxa-border/50 hover:bg-hxa-bg-hover transition-colors">
                    <td className="px-4 py-3 font-medium">{org.name}</td>
                    <td className="px-4 py-3"><CopyableCode value={org.id} display={`${org.id.slice(0, 12)}...`} /></td>
                    <td className="px-4 py-3"><StatusBadge status={org.status} /></td>
                    <td className="px-4 py-3">{org.bot_count}</td>
                    <td className="px-4 py-3 text-hxa-text-dim">{new Date(org.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setSelectedOrg(org)} className="px-2 py-1 text-xs bg-hxa-blue/20 text-hxa-blue rounded hover:bg-hxa-blue/30 border border-hxa-blue/30">
                          <Eye size={12} />
                        </button>
                        {org.status === 'active' && (
                          <button
                            onClick={() => setConfirm({
                              title: t('admin.suspend.title'),
                              message: t('admin.suspend.message', { name: org.name }),
                              confirmLabel: t('admin.suspend.confirm'),
                              danger: true,
                              onConfirm: async () => {
                                setConfirm(null);
                                try { await superAdmin.updateOrgStatus(org.id, 'suspended'); loadData(); showToast(t('admin.suspend.success')); } catch { showToast(t('admin.suspend.error'), 'error'); }
                              },
                              onCancel: () => setConfirm(null),
                            })}
                            className="px-2 py-1 text-xs bg-hxa-amber/20 text-hxa-amber rounded hover:bg-hxa-amber/30 border border-hxa-amber/30"
                          >
                            <Pause size={12} />
                          </button>
                        )}
                        {org.status === 'suspended' && (
                          <button
                            onClick={async () => {
                              try { await superAdmin.updateOrgStatus(org.id, 'active'); loadData(); showToast(t('admin.activate.success')); } catch { showToast(t('admin.activate.error'), 'error'); }
                            }}
                            className="px-2 py-1 text-xs bg-hxa-green/20 text-hxa-green rounded hover:bg-hxa-green/30 border border-hxa-green/30"
                          >
                            <Play size={12} />
                          </button>
                        )}
                        <button
                          onClick={() => setConfirm({
                            title: t('admin.rotate.title'),
                            message: t('admin.rotate.message', { name: org.name }),
                            confirmLabel: t('admin.rotate.confirm'),
                            onConfirm: async () => {
                              setConfirm(null);
                              try {
                                const result = await superAdmin.rotateSecret(org.id);
                                setSecretModal({ title: t('admin.rotate.secretTitle', { name: org.name }), secret: result.org_secret, hint: t('admin.secretHint') });
                              } catch { showToast(t('admin.rotate.error'), 'error'); }
                            },
                            onCancel: () => setConfirm(null),
                          })}
                          className="px-2 py-1 text-xs bg-hxa-purple/20 text-hxa-purple rounded hover:bg-hxa-purple/30 border border-hxa-purple/30"
                        >
                          <RotateCw size={12} />
                        </button>
                        {org.status !== 'destroyed' && (
                          <button
                            onClick={() => setConfirm({
                              title: t('admin.destroy.title'),
                              message: t('admin.destroy.message', { name: org.name }),
                              confirmLabel: t('admin.destroy.confirm'),
                              danger: true,
                              typeTo: org.name,
                              onConfirm: async () => {
                                setConfirm(null);
                                try { await superAdmin.destroyOrg(org.id); loadData(); showToast(t('admin.destroy.success')); } catch { showToast(t('admin.destroy.error'), 'error'); }
                              },
                              onCancel: () => setConfirm(null),
                            })}
                            className="px-2 py-1 text-xs bg-hxa-red/20 text-hxa-red rounded hover:bg-hxa-red/30 border border-hxa-red/30"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {orgs.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-hxa-text-dim">{t('admin.noOrgs')}</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </section>

        {/* Invite Codes */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{t('admin.section.inviteCodes')}</h2>
            <button onClick={() => setShowCreateCode(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-hxa-accent/20 text-hxa-accent rounded-lg hover:bg-hxa-accent/30 border border-hxa-accent/30 transition-colors">
              <Plus size={14} /> {t('admin.createCode')}
            </button>
          </div>
          <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl overflow-hidden">
            <div className="max-h-[40vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[#0a0f1a] z-[1]">
                <tr className="border-b border-hxa-border text-hxa-text-dim text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-3">{t('admin.table.label')}</th>
                  <th className="text-left px-4 py-3">{t('admin.table.code')}</th>
                  <th className="text-left px-4 py-3">{t('admin.table.uses')}</th>
                  <th className="text-left px-4 py-3">{t('admin.table.expires')}</th>
                  <th className="text-left px-4 py-3">{t('admin.table.status')}</th>
                  <th className="text-right px-4 py-3">{t('admin.table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {inviteCodes.map(code => {
                  const expired = code.expires_at && new Date(code.expires_at) < new Date();
                  const exhausted = code.max_uses > 0 && code.use_count >= code.max_uses;
                  return (
                    <tr key={code.id} className="border-b border-hxa-border/50 hover:bg-hxa-bg-hover transition-colors">
                      <td className="px-4 py-3">{code.label || '—'}</td>
                      <td className="px-4 py-3">
                        <CopyableCode value={code.code || code.id} />
                      </td>
                      <td className="px-4 py-3">{code.use_count}{code.max_uses > 0 ? ` / ${code.max_uses}` : ' / ∞'}</td>
                      <td className="px-4 py-3 text-hxa-text-dim">{code.expires_at ? new Date(code.expires_at).toLocaleDateString() : t('admin.expires.never')}</td>
                      <td className="px-4 py-3">
                        {expired ? <span className="text-xs text-hxa-red">{t('admin.status.expired')}</span>
                          : exhausted ? <span className="text-xs text-hxa-amber">{t('admin.status.exhausted')}</span>
                          : <span className="text-xs text-hxa-green">{t('admin.status.active')}</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setConfirm({
                            title: t('admin.revoke.title'),
                            message: t('admin.revoke.message', { name: code.label || code.id.slice(0, 12) }),
                            confirmLabel: t('admin.revoke.confirm'),
                            danger: true,
                            onConfirm: async () => {
                              setConfirm(null);
                              try { await superAdmin.revokeInviteCode(code.id); loadData(); showToast(t('admin.revoke.success')); } catch { showToast(t('admin.revoke.error'), 'error'); }
                            },
                            onCancel: () => setConfirm(null),
                          })}
                          className="px-2 py-1 text-xs bg-hxa-red/20 text-hxa-red rounded hover:bg-hxa-red/30 border border-hxa-red/30"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {inviteCodes.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-hxa-text-dim">{t('admin.noInviteCodes')}</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

// ─── Create Org Modal ───

function CreateOrgModal({ onClose, onCreated }: {
  onClose: () => void; onCreated: (name: string, orgId: string, secret: string) => void;
}) {
  const { t } = useTranslations();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError(t('admin.createOrg.nameRequired')); return; }
    setError('');
    setLoading(true);
    try {
      const result = await superAdmin.createOrg(name.trim());
      onCreated(result.name, result.id, result.org_secret);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : t('admin.createOrg.error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form onSubmit={handleSubmit} className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">{t('admin.createOrg.title')}</h3>
          <button type="button" onClick={onClose} className="text-hxa-text-dim hover:text-hxa-text"><X size={18} /></button>
        </div>
        <input
          type="text"
          placeholder={t('admin.createOrg.placeholder')}
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full bg-black/30 border border-hxa-border rounded-lg px-4 py-3 text-sm outline-none focus:border-hxa-accent mb-3"
          autoFocus
        />
        {error && <p className="text-hxa-red text-sm mb-3">{error}</p>}
        <button type="submit" disabled={loading} className="w-full gradient-btn rounded-lg py-2.5 text-sm font-bold disabled:opacity-50">
          {loading ? t('admin.createOrg.creating') : t('admin.createOrg.create')}
        </button>
      </form>
    </div>
  );
}

// ─── Create Code Modal ───

function CreateCodeModal({ onClose, onCreated }: {
  onClose: () => void; onCreated: (code: string) => void;
}) {
  const { t } = useTranslations();
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('0');
  const [expiresIn, setExpiresIn] = useState('0');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await superAdmin.createInviteCode({
        label: label.trim() || undefined,
        max_uses: parseInt(maxUses) || 0,
        expires_in: parseInt(expiresIn) || 0,
      });
      onCreated(result.code || result.id);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : t('admin.createCode.error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form onSubmit={handleSubmit} className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">{t('admin.createCode.title')}</h3>
          <button type="button" onClick={onClose} className="text-hxa-text-dim hover:text-hxa-text"><X size={18} /></button>
        </div>
        <div className="flex flex-col gap-3 mb-4">
          <input
            type="text"
            placeholder={t('admin.createCode.labelPlaceholder')}
            value={label}
            onChange={e => setLabel(e.target.value)}
            className="bg-black/30 border border-hxa-border rounded-lg px-4 py-2.5 text-sm outline-none focus:border-hxa-accent"
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-hxa-text-dim mb-1 block">{t('admin.createCode.maxUses')}</label>
              <input
                type="number"
                value={maxUses}
                onChange={e => setMaxUses(e.target.value)}
                className="w-full bg-black/30 border border-hxa-border rounded-lg px-3 py-2 text-sm outline-none focus:border-hxa-accent font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-hxa-text-dim mb-1 block">{t('admin.createCode.expiresIn')}</label>
              <input
                type="number"
                value={expiresIn}
                onChange={e => setExpiresIn(e.target.value)}
                className="w-full bg-black/30 border border-hxa-border rounded-lg px-3 py-2 text-sm outline-none focus:border-hxa-accent font-mono"
              />
            </div>
          </div>
        </div>
        {error && <p className="text-hxa-red text-sm mb-3">{error}</p>}
        <button type="submit" disabled={loading} className="w-full gradient-btn rounded-lg py-2.5 text-sm font-bold disabled:opacity-50">
          {loading ? t('admin.createCode.creating') : t('admin.createCode.create')}
        </button>
      </form>
    </div>
  );
}
