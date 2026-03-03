'use client';

import { Component, type ReactNode } from 'react';
import OrgDashboard from './client';

interface ErrorState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', color: '#fff', background: '#111', minHeight: '100vh' }}>
          <h1 style={{ color: '#f55' }}>Client Error</h1>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#faa' }}>{this.state.error?.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#888', fontSize: 12, marginTop: 16 }}>{this.state.error?.stack}</pre>
          <button onClick={() => window.location.reload()} style={{ marginTop: 20, padding: '8px 16px', background: '#333', color: '#fff', border: '1px solid #555', borderRadius: 4, cursor: 'pointer' }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function OrgWrapper() {
  return (
    <ErrorBoundary>
      <OrgDashboard />
    </ErrorBoundary>
  );
}
