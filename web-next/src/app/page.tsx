'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import * as api from '@/lib/api';
import { AdminApiError, orgAdmin } from '@/lib/admin-api';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

type LoginTab = 'org' | 'bot';

export default function LoginPage() {
  const router = useRouter();
  const [tab, setTab] = useState<LoginTab>('org');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Bot login fields
  const [token, setToken] = useState('');
  const [ownerName, setOwnerName] = useState('');

  // Org admin login fields
  const [orgId, setOrgId] = useState('');
  const [orgSecret, setOrgSecret] = useState('');

  // Check existing session and route by role
  useEffect(() => {
    api.getSession()
      .then((session) => {
        switch (session.role) {
          case 'bot_owner': router.replace('/dashboard/'); break;
          case 'org_admin': router.replace('/org/'); break;
          case 'super_admin': router.replace('/admin/'); break;
          default: setLoading(false);
        }
      })
      .catch(() => setLoading(false));
  }, [router]);

  async function handleBotLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      if (!token.trim() || !ownerName.trim()) {
        setError('Bot token and display name are required');
        return;
      }
      await api.login({ token: token.trim(), owner_name: ownerName.trim() });
      router.replace('/dashboard/');
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOrgLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      if (!orgId.trim() || !orgSecret.trim()) {
        setError('Org ID and org secret are required');
        return;
      }

      await orgAdmin.login(orgId.trim(), orgSecret.trim());
      router.replace('/org/');
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-3 border-hxa-accent/20 border-t-hxa-accent animate-spin" />
      </div>
    );
  }

  const inputClass =
    'bg-black/30 border border-hxa-border rounded-lg px-4 py-3.5 text-hxa-text font-mono text-sm outline-none transition-all focus:border-hxa-accent focus:shadow-[0_0_0_3px_rgba(45,212,191,0.15)] focus:bg-black/50 w-full';

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-5 p-4">
      {/* Logo */}
      <div className="flex flex-col items-center gap-4 mb-2">
        <img src={`${BASE_PATH}/images/logo.png`} alt="HXA-Connect" className="h-12 animate-pulse-glow" style={{ filter: 'drop-shadow(0 0 12px rgba(45,212,191,0.6))' }} />
        <h1 className="text-3xl font-bold gradient-text">HXA-Connect</h1>
        <p className="text-hxa-text-dim text-sm tracking-wider uppercase font-medium">
          Communication Hub
        </p>
      </div>

      {/* Login Box */}
      <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-9 w-full max-w-[420px] flex flex-col gap-5 shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)] hover:border-hxa-border-glow transition-all">
        {/* Tabs */}
        <div className="flex border-b border-hxa-border">
          <button
            type="button"
            onClick={() => { setTab('org'); setError(''); }}
            className={`flex-1 pb-3 text-sm font-semibold uppercase tracking-wider transition-all ${
              tab === 'org'
                ? 'text-hxa-accent border-b-2 border-hxa-accent'
                : 'text-hxa-text-dim hover:text-hxa-text'
            }`}
          >
            Org Admin
          </button>
          <button
            type="button"
            onClick={() => { setTab('bot'); setError(''); }}
            className={`flex-1 pb-3 text-sm font-semibold uppercase tracking-wider transition-all ${
              tab === 'bot'
                ? 'text-hxa-accent border-b-2 border-hxa-accent'
                : 'text-hxa-text-dim hover:text-hxa-text'
            }`}
          >
            Bot Login
          </button>
        </div>

        {/* Org Admin Form */}
        {tab === 'org' && (
          <form onSubmit={handleOrgLogin} className="flex flex-col gap-5">
            <input
              type="text"
              placeholder="Org ID"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              className={inputClass}
            />
            <input
              type="password"
              placeholder="Org Secret"
              value={orgSecret}
              onChange={(e) => setOrgSecret(e.target.value)}
              className={inputClass}
            />
            {error && (
              <p className="text-hxa-red text-sm text-center">{error}</p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="gradient-btn rounded-lg py-3.5 text-[15px] font-bold cursor-pointer transition-all mt-2 shadow-[0_4px_12px_rgba(45,212,191,0.2)] hover:-translate-y-0.5 hover:shadow-[0_0_15px_rgba(45,212,191,0.4)] active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Connecting...' : 'Connect'}
            </button>
          </form>
        )}

        {/* Bot Login Form */}
        {tab === 'bot' && (
          <form onSubmit={handleBotLogin} className="flex flex-col gap-5">
            <input
              type="password"
              placeholder="Bot Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className={inputClass}
            />
            <input
              type="text"
              placeholder="Display Name"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              className={inputClass}
            />
            {error && (
              <p className="text-hxa-red text-sm text-center">{error}</p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="gradient-btn rounded-lg py-3.5 text-[15px] font-bold cursor-pointer transition-all mt-2 shadow-[0_4px_12px_rgba(45,212,191,0.2)] hover:-translate-y-0.5 hover:shadow-[0_0_15px_rgba(45,212,191,0.4)] active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Connecting...' : 'Connect'}
            </button>
          </form>
        )}
      </div>

      {/* Super Admin Console Link */}
      <a
        href={`${BASE_PATH}/admin/`}
        className="text-hxa-text-dim text-sm hover:text-hxa-accent transition-colors"
      >
        Super Admin Console &rarr;
      </a>
    </div>
  );
}
