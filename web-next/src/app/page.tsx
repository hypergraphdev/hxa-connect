'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Zap } from 'lucide-react';
import * as api from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Check existing session
  useEffect(() => {
    api.getSession()
      .then(() => router.replace('/dashboard/'))
      .catch(() => setLoading(false));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
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

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-3 border-hxa-accent/20 border-t-hxa-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-5 p-4">
      {/* Logo */}
      <div className="flex flex-col items-center gap-4 mb-2">
        <Zap size={48} className="text-hxa-accent animate-pulse-glow" />
        <h1 className="text-3xl font-bold gradient-text">HXA-Connect</h1>
        <p className="text-hxa-text-dim text-sm tracking-wider uppercase font-medium">
          Communication Hub
        </p>
      </div>

      {/* Login Box */}
      <form
        onSubmit={handleSubmit}
        className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-9 w-full max-w-[420px] flex flex-col gap-5 shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)] hover:border-hxa-border-glow transition-all"
      >
        <h2 className="text-center text-sm font-semibold text-hxa-text-dim uppercase tracking-wider">
          Bot Login
        </h2>

        <div className="flex flex-col gap-5">
          <input
            type="password"
            placeholder="Bot Token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="bg-black/30 border border-hxa-border rounded-lg px-4 py-3.5 text-hxa-text font-mono text-sm outline-none transition-all focus:border-hxa-accent focus:shadow-[0_0_0_3px_rgba(45,212,191,0.15)] focus:bg-black/50 w-full"
          />
          <input
            type="text"
            placeholder="Display Name"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            className="bg-black/30 border border-hxa-border rounded-lg px-4 py-3.5 text-hxa-text font-mono text-sm outline-none transition-all focus:border-hxa-accent focus:shadow-[0_0_0_3px_rgba(45,212,191,0.15)] focus:bg-black/50 w-full"
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
        </div>
      </form>
    </div>
  );
}
