'use client';

import { useState, useEffect } from 'react';
import { X, ChevronDown, ChevronRight, Loader2, FileCode, FileJson, FileText, Link2, File } from 'lucide-react';
import * as api from '@/lib/api';
import type { Artifact } from '@/lib/types';
import { cn, formatTime } from '@/lib/utils';
import { MarkdownContent } from '@/components/ui/MarkdownContent';

interface ArtifactPanelProps {
  threadId: string;
  open: boolean;
  onClose: () => void;
  /** Real-time artifact updates from WS */
  wsArtifacts?: Artifact[];
}

export function ArtifactPanel({ threadId, open, onClose, wsArtifacts }: ArtifactPanelProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);

    api.getThreadArtifacts(threadId)
      .then((res) => {
        if (!cancelled) setArtifacts(res);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [threadId, open]);

  // Merge WS artifact updates
  useEffect(() => {
    if (!wsArtifacts?.length) return;
    setArtifacts((prev) => {
      const updated = [...prev];
      for (const wa of wsArtifacts) {
        if (wa.thread_id !== threadId) continue;
        const idx = updated.findIndex((a) => a.id === wa.id);
        if (idx >= 0) {
          updated[idx] = wa;
        } else {
          updated.push(wa);
        }
      }
      return updated;
    });
  }, [wsArtifacts, threadId]);

  if (!open) return null;

  return (
    <div className="w-[380px] shrink-0 border-l border-hxa-border bg-[rgba(10,15,26,0.6)] flex flex-col max-md:fixed max-md:inset-0 max-md:w-full max-md:z-[1000] max-md:bg-[#0a0f1a]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-hxa-border shrink-0">
        <h3 className="text-sm font-semibold text-hxa-text flex items-center gap-1.5">
          <FileText size={14} className="text-hxa-accent" />
          Artifacts
          <span className="text-xs text-hxa-text-muted font-normal">({artifacts.length})</span>
        </h3>
        <button onClick={onClose} className="text-hxa-text-dim hover:text-hxa-text p-1 transition-colors">
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-hxa-accent" />
          </div>
        ) : artifacts.length === 0 ? (
          <div className="text-center text-hxa-text-muted text-sm py-8">
            No artifacts yet
          </div>
        ) : (
          artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Artifact Card ───

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [expanded, setExpanded] = useState(false);

  const icon = getTypeIcon(artifact.type);

  return (
    <div className="border border-hxa-border rounded-lg overflow-hidden bg-black/20">
      {/* Header — clickable */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-white/[0.02] transition-colors"
      >
        {expanded ? <ChevronDown size={14} className="text-hxa-text-muted shrink-0" /> : <ChevronRight size={14} className="text-hxa-text-muted shrink-0" />}
        {icon}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-hxa-text truncate font-mono">{artifact.artifact_key}</div>
          <div className="text-[10px] text-hxa-text-muted mt-0.5">
            v{artifact.version} · {artifact.type} · {formatTime(artifact.updated_at)}
          </div>
        </div>
      </button>

      {/* Content */}
      {expanded && (
        <div className="border-t border-hxa-border">
          <ArtifactContent artifact={artifact} />
        </div>
      )}
    </div>
  );
}

function getTypeIcon(type: string) {
  switch (type) {
    case 'json': return <FileJson size={14} className="text-yellow-400 shrink-0" />;
    case 'code': return <FileCode size={14} className="text-blue-400 shrink-0" />;
    case 'markdown': return <FileText size={14} className="text-purple-400 shrink-0" />;
    case 'file': return <File size={14} className="text-green-400 shrink-0" />;
    case 'link': return <Link2 size={14} className="text-hxa-accent shrink-0" />;
    default: return <FileText size={14} className="text-hxa-text-muted shrink-0" />;
  }
}

function ArtifactContent({ artifact }: { artifact: Artifact }) {
  const ct = artifact.type;
  const content = artifact.content ?? '';

  // JSON — pretty print
  if (ct === 'json') {
    let pretty = content;
    try { pretty = JSON.stringify(JSON.parse(content), null, 2); } catch {}
    return (
      <pre className="px-3 py-2 text-xs font-mono text-hxa-text overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre">
        {pretty}
      </pre>
    );
  }

  // Code
  if (ct === 'code') {
    return (
      <pre className="px-3 py-2 text-xs font-mono text-hxa-text overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre">
        {content}
      </pre>
    );
  }

  // File — show link if url exists
  if (ct === 'file' && artifact.url) {
    return (
      <div className="px-3 py-2">
        <a href={artifact.url} target="_blank" rel="noopener noreferrer" className="text-xs text-hxa-accent hover:underline break-all">
          {artifact.title || artifact.artifact_key}
        </a>
      </div>
    );
  }

  // Link
  if (ct === 'link') {
    return (
      <div className="px-3 py-2">
        <a href={artifact.url || content} target="_blank" rel="noopener noreferrer" className="text-xs text-hxa-accent hover:underline break-all">
          {artifact.title || artifact.url || content}
        </a>
      </div>
    );
  }

  // Markdown — render with MarkdownContent
  if (ct === 'markdown') {
    return (
      <div className="px-3 py-2 text-xs max-h-[400px] overflow-y-auto">
        <MarkdownContent content={content} />
      </div>
    );
  }

  // Text / default — pre-wrap
  return (
    <div className="px-3 py-2 text-xs text-hxa-text whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto">
      {content}
    </div>
  );
}
