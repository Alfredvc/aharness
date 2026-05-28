import { useEffect, useRef, useState } from 'react';
import type { UiState, UiActions } from '../state/store';

export function OwnerInputComposer({ session }: { session: UiState & UiActions }) {
  const req = session.pending.ownerInput;
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (req) {
      setValues(Object.fromEntries(req.questions.map((q) => [q.id, ''])));
      setSubmitting(false);
      setError(null);
      const t = setTimeout(() => ref.current?.focus(), 220);
      return () => clearTimeout(t);
    }
    return;
  }, [req?.id]);

  async function send() {
    if (!req || submitting) return;
    const answers = Object.fromEntries(
      req.questions.map((q) => [q.id, (values[q.id] ?? '').trim()]),
    );
    if (Object.values(answers).some((answer) => answer.length === 0)) return;
    setSubmitting(true);
    setError(null);
    try {
      await session.reply({
        kind: 'owner-input',
        requestId: req.id,
        answers,
      });
      setValues(Object.fromEntries(req.questions.map((q) => [q.id, ''])));
    } catch {
      setError('reply failed; input retained');
    } finally {
      setSubmitting(false);
    }
  }

  const allFilled =
    req !== null && req.questions.every((q) => (values[q.id] ?? '').trim().length > 0);

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="composer" data-active={Boolean(req)}>
      <div className="composer-head">
        <span className="label">state asks</span>
        <span className="state">{session.state?.path ?? ''}</span>
      </div>
      <div className="multi-form">
        {req?.questions.map((q, index) => (
          <label key={q.id} className="multi-field">
            <span className="multi-q">
              {q.header ? <span className="multi-header">{q.header}</span> : null}
              {q.question}
            </span>
            <textarea
              ref={index === 0 ? ref : null}
              value={values[q.id] ?? ''}
              onChange={(e) => setValues((current) => ({ ...current, [q.id]: e.target.value }))}
              onKeyDown={onKey}
              placeholder=""
              spellCheck={false}
            />
          </label>
        ))}
      </div>
      <div className="input-row">
        <button className="send" onClick={() => void send()} disabled={!allFilled || submitting}>
          {submitting
            ? 'sending…'
            : `send ${req?.questions.length ?? 0} answer${req?.questions.length === 1 ? '' : 's'} →`}
        </button>
      </div>
      {error ? <div className="slot-error">{error}</div> : null}
      <div className="hint">
        <kbd>⌘</kbd>+<kbd>↵</kbd> to send · routes through <code>POST /api/reply</code>
      </div>
    </div>
  );
}
