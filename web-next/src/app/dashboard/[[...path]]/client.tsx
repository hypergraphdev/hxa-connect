'use client';

import { useState } from 'react';
import { Zap, Mail } from 'lucide-react';
import { useSession } from '@/hooks/useSession';
import { useWsEvents, useDashNav } from '../shell';
import { ThreadView } from '@/components/thread/ThreadView';
import { ArtifactPanel } from '@/components/thread/ArtifactPanel';
import { DMView } from '@/components/dm/DMView';

// ─── Welcome View ───

function WelcomeView() {
  const { session } = useSession();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-hxa-text-dim">
      <Zap size={64} className="text-hxa-accent/30" />
      <h2 className="text-xl font-semibold text-hxa-text">
        Welcome, {session?.owner_name}
      </h2>
      <p className="text-sm">
        Select a thread or DM from the sidebar to get started.
      </p>
      <div className="flex gap-3 mt-2">
        <span className="text-xs font-mono bg-hxa-accent/10 border border-hxa-accent/20 text-hxa-accent px-3 py-1 rounded-full">
          {session?.bot?.name}
        </span>
      </div>
    </div>
  );
}

// ─── Thread Section (with artifact panel) ───

function ThreadSection({ id }: { id?: string }) {
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const { wsMessages, wsArtifacts, wsThread, wsThreadStatusChange, wsParticipantEvents, wsBotStatusEvents } = useWsEvents();

  if (!id) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-hxa-text-dim">
        <Zap size={48} className="text-hxa-accent/30" />
        <p className="text-sm">Select a thread from the sidebar</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0">
      <ThreadView
        threadId={id}
        wsMessages={wsMessages}
        wsThread={wsThread}
        wsThreadStatusChange={wsThreadStatusChange}
        wsParticipantEvents={wsParticipantEvents}
        wsBotStatusEvents={wsBotStatusEvents}
        onOpenArtifacts={() => setArtifactsOpen((o) => !o)}
      />
      <ArtifactPanel
        threadId={id}
        open={artifactsOpen}
        onClose={() => setArtifactsOpen(false)}
        wsArtifacts={wsArtifacts}
      />
    </div>
  );
}

// ─── DM Section ───

function DmSection({ id }: { id?: string }) {
  const { wsDmMessages } = useWsEvents();

  if (!id) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-hxa-text-dim">
        <Mail size={48} className="text-hxa-accent/30" />
        <p className="text-sm">Select a conversation from the sidebar</p>
      </div>
    );
  }

  return <DMView channelId={id} wsDmMessages={wsDmMessages} />;
}

// ─── Client-side router ───

export default function DashboardCatchAll() {
  const { section, id } = useDashNav();

  switch (section) {
    case 'threads':
      return <ThreadSection id={id} />;
    case 'dms':
      return <DmSection id={id} />;
    default:
      return <WelcomeView />;
  }
}
