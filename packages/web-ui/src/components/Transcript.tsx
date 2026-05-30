import { useEffect, useRef } from 'react';
import type { UiState, TranscriptItem } from '../state/store';

export function Transcript({ session }: { session: UiState }) {
  const { transcript, run, connection, posture } = session;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [transcript.length]);

  return (
    <>
      <div className="stage-head">
        <span className="pill" data-tone="indigo">
          {posture.isAwaiting ? 'awaiting owner' : posture.isTerminal ? 'terminal' : 'live'}
        </span>
        <span className="file">{run?.fsmFile ?? 'connecting...'}</span>
        <span className="conn" data-state={connection}>
          <span className="led" aria-hidden /> {connection}
        </span>
      </div>
      <div className="transcript" ref={scrollRef}>
        <div className="transcript-inner">
          {transcript.map((item) => (
            <TranscriptRow key={item.id} item={item} />
          ))}
        </div>
      </div>
    </>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.type) {
    case 'agent_message':
      return (
        <article className={`msg agent-msg${item.streaming ? ' streaming' : ''}`}>
          <header className="msg-head">
            <span className="by">model · assistant</span>
          </header>
          <div className="body" dangerouslySetInnerHTML={{ __html: renderInline(item.text) }} />
        </article>
      );
    case 'user_message':
      return (
        <article className="msg user-msg">
          <header className="msg-head">
            <span className="by">user · orientation</span>
          </header>
          <div className="body">{item.text}</div>
        </article>
      );
    case 'reasoning':
      return (
        <article className="msg agent-msg">
          <header className="msg-head">
            <span className="by quiet">model · reasoning</span>
          </header>
          <div className="body quiet" style={{ fontStyle: 'italic' }}>
            {item.text}
          </div>
        </article>
      );
    case 'tool_call':
      return (
        <article className="tool-call">
          <header className="tc-head">
            {item.status === 'pending' ? <span className="spin" aria-hidden /> : null}
            <span className="name">{item.name}</span>
            <span className="badge" data-status={item.status}>
              {item.status}
            </span>
          </header>
          {item.preview ? <div className="tc-preview">{item.preview}</div> : null}
        </article>
      );
    case 'tool_result':
      return (
        <div className="tool-result" data-ok={item.ok}>
          <span className="glyph" aria-hidden>
            {item.ok ? '✓' : '✗'}
          </span>
          <div>
            <div style={{ fontSize: 10.5, letterSpacing: '0.24em', textTransform: 'uppercase' }}>
              {item.name} · {item.ok ? 'completed' : 'failed'}
            </div>
            <div>{item.output}</div>
          </div>
        </div>
      );
    case 'framework_note':
      if (!item.text) return null;
      return (
        <div className="fw-note" data-variant={item.variant}>
          <span className="rule" aria-hidden />
          <span className="body">{item.text}</span>
          <span className="rule" aria-hidden />
        </div>
      );
    case 'compact_status':
      return (
        <div className="compact-row" data-kind={item.category} data-status={item.status ?? 'info'}>
          <span className="compact-kicker">{item.category}</span>
          <span className="compact-label">{item.label}</span>
          {item.status ? <span className="compact-status">{item.status}</span> : null}
          {item.summary ? <span className="compact-summary">{item.summary}</span> : null}
        </div>
      );
    case 'state_change':
      return (
        <div className="state-change">
          <span className="stem" aria-hidden />
          <span className="text">
            <span className="label">transition · {item.cause}</span>
            <span className="from">{item.from?.split('.').pop() ?? 'boot'}</span>
            <span className="arrow">→</span>
            <span>{item.to.split('.').pop()}</span>
          </span>
          <span className="stem" aria-hidden />
        </div>
      );
    case 'fresh_clear_boundary':
      return (
        <div className="fresh-clear-boundary">
          <span className="lead">fresh clear · replacement thread</span>
          <div>
            {shortThread(item.previousThreadId)} → {shortThread(item.nextThreadId)} ·{' '}
            {item.statePath}
          </div>
        </div>
      );
    default:
      return null;
  }
}

function renderInline(text: string) {
  // Minimal markdown-y: backticks → <code>, escape angle brackets.
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return esc.replace(/`([^`]+?)`/g, '<code>$1</code>');
}

function shortThread(threadId: string): string {
  return threadId.length <= 12 ? threadId : `${threadId.slice(0, 8)}…${threadId.slice(-4)}`;
}
