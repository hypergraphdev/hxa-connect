/**
 * Slock daemon protocol — types used to talk to @slock-ai/daemon over WS
 * at /daemon/connect?key=<bot_token>. Mirrors the messages defined in
 * slock-daemon's src/core.ts handleMessage/handleConnect.
 *
 * Only the subset used by the MVP is modeled here; anything we receive but
 * don't handle is logged and ignored.
 */

/** Inbound: messages the daemon sends to us. */
export type DaemonInbound =
  | DaemonReady
  | DaemonPong
  | DaemonAgentStatus
  | DaemonAgentActivity
  | DaemonAgentSession
  | DaemonAgentDeliverAck
  | { type: string; [k: string]: unknown };

export interface DaemonReady {
  type: 'ready';
  capabilities?: string[];
  runtimes?: string[];
  runningAgents?: string[];
  hostname?: string;
  os?: string;
  daemonVersion?: string;
}

export interface DaemonPong { type: 'pong'; }

export interface DaemonAgentStatus {
  type: 'agent:status';
  agentId: string;
  status: 'active' | 'inactive';
  launchId?: string | null;
}

export interface DaemonAgentActivity {
  type: 'agent:activity';
  agentId: string;
  activity: 'working' | 'online' | 'offline';
  detail?: string;
  launchId?: string | null;
}

export interface DaemonAgentSession {
  type: 'agent:session';
  agentId: string;
  sessionId: string;
  launchId?: string;
}

export interface DaemonAgentDeliverAck {
  type: 'agent:deliver:ack';
  agentId: string;
  seq: number;
}

/** Outbound: messages we send to the daemon. */
export type DaemonOutbound =
  | DaemonAgentStart
  | DaemonAgentStop
  | DaemonAgentDeliver
  | DaemonPing;

export interface DaemonAgentStart {
  type: 'agent:start';
  agentId: string;
  config: DaemonAgentConfig;
  wakeMessage?: DaemonDeliveredMessage;
  unreadSummary?: Record<string, number>;
  resumePrompt?: string;
  launchId?: string;
}

export interface DaemonAgentStop {
  type: 'agent:stop';
  agentId: string;
}

export interface DaemonAgentDeliver {
  type: 'agent:deliver';
  agentId: string;
  seq: number;
  message: DaemonDeliveredMessage;
}

export interface DaemonPing { type: 'ping'; }

/** Config passed to the daemon to spawn a CLI child process. */
export interface DaemonAgentConfig {
  runtime: 'claude' | 'codex' | 'copilot' | 'cursor' | 'gemini' | 'kimi';
  model?: string;
  name?: string;
  displayName?: string;
  description?: string;
  sessionId?: string | null;
  serverUrl: string;
  authToken?: string;
  envVars?: Record<string, string>;
}

/** The message body daemon expects inside agent:deliver / wakeMessage. */
export interface DaemonDeliveredMessage {
  message_id: string;
  channel_type: 'dm' | 'channel' | 'thread';
  channel_name: string;
  sender_id: string;
  sender_name: string;
  content: string;
  created_at: number;
  /**
   * Slock's formatMessageTarget treats channel_type='thread' as nested under
   * a parent. For hub threads (which are top-level), we synthesize a parent
   * using the thread's topic so the CLI produces the reply target
   * `#<topic>:<thread_id>`.
   */
  parent_channel_type?: 'channel' | 'dm';
  parent_channel_name?: string;
  /** For thread messages: the hub thread id — lets daemons reply in-thread. */
  thread_id?: string;
}
