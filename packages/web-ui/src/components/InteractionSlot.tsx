import { useEffect, useRef, useState } from 'react';
import type { OwnerChoiceRequest, OwnerInputRequest } from '../types/events';
import type { UiActions } from '../state/store';

type Props = {
  req: OwnerInputRequest;
  reply: UiActions['reply'];
};

type OwnerChoiceProps = {
  req: OwnerChoiceRequest;
  reply: UiActions['reply'];
};

export function InteractionSlot({ req, reply }: Props) {
  const flavor = pickFlavor(req);
  if (flavor === 'choice') return <ChoiceSlot req={req} reply={reply} />;
  if (flavor === 'multi') return <MultiQuestionSlot req={req} reply={reply} />;
  return <FreeTextSlot req={req} reply={reply} />;
}

export function OwnerChoiceSlot({ req, reply }: OwnerChoiceProps) {
  const [cursor, setCursor] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const options = req.options;

  useEffect(() => {
    setCursor(0);
    submittingRef.current = false;
    setSubmitting(false);
    setError(null);
  }, [req.requestId]);

  async function commit(label: string) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await reply({
        kind: 'owner-choice',
        state: req.state,
        visitCount: req.visitCount,
        label,
      });
    } catch {
      setError('choice failed; selection retained');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function pick(i: number) {
    if (submittingRef.current) return;
    if (i < 0 || i >= options.length) return;
    void commit(options[i]?.label ?? '');
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (submittingRef.current) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setCursor((c) => Math.min(options.length - 1, c + 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pick(cursor);
      } else if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < options.length) {
          e.preventDefault();
          pick(i);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cursor, options, req.requestId]);

  return (
    <div
      className="slot slot-choice slot-owner-choice"
      data-submitting={submitting ? 'true' : 'false'}
    >
      <div className="slot-head">
        <span className="dot" aria-hidden />
        <span className="label">framework choice</span>
      </div>
      <div className="slot-q">{req.question}</div>
      <ul className="choices">
        {options.map((option, i) => (
          <li
            key={option.label}
            className={`choice ${i === cursor ? 'on' : ''}`}
            aria-disabled={submitting}
            onMouseEnter={() => {
              if (!submittingRef.current) setCursor(i);
            }}
            onClick={() => pick(i)}
          >
            <span className="num">{i + 1}</span>
            <span className="text">{option.label}</span>
          </li>
        ))}
      </ul>
      {error ? <div className="slot-error">{error}</div> : null}
      <div className="slot-hint">
        <kbd>↑</kbd>/<kbd>↓</kbd> nav · <kbd>↵</kbd> confirm · <kbd>1</kbd>–
        <kbd>{options.length}</kbd> jump
      </div>
    </div>
  );
}

function pickFlavor(req: OwnerInputRequest): 'free' | 'choice' | 'multi' {
  if (req.questions.length > 1) return 'multi';
  const q = req.questions[0];
  if (q?.choices && q.choices.length > 0) return 'choice';
  return 'free';
}

/* ─────────────────────────────────────────────────────── free text */

function FreeTextSlot({ req, reply }: Props) {
  const q = req.questions[0];
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue('');
    setError(null);
    setSubmitting(false);
    const t = setTimeout(() => ref.current?.focus(), 220);
    return () => clearTimeout(t);
  }, [req.id]);

  async function send() {
    if (!q || !value.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await reply({
        kind: 'owner-input',
        requestId: req.id,
        answers: { [q.id]: value.trim() },
      });
      setValue('');
    } catch {
      setError('reply failed; input retained');
    } finally {
      setSubmitting(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
    if (e.key === 'Escape') ref.current?.blur();
  }

  return (
    <div className="slot slot-free">
      <div className="slot-head">
        <span className="dot" aria-hidden />
        <span className="label">awaits owner — free text</span>
      </div>
      <div className="slot-q">{q?.question ?? ''}</div>
      <div className="slot-row">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type your reply. Agent waits."
          spellCheck={false}
        />
        <button
          className="slot-send"
          onClick={() => void send()}
          disabled={!value.trim() || submitting}
        >
          {submitting ? 'sending…' : 'send →'}
        </button>
      </div>
      {error ? <div className="slot-error">{error}</div> : null}
      <div className="slot-hint">
        <kbd>⌘</kbd>+<kbd>↵</kbd> send · <kbd>esc</kbd> defocus
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── owner-input choice */

function ChoiceSlot({ req, reply }: Props) {
  const q = req.questions[0];
  const choices = q?.choices ?? [];
  const [cursor, setCursor] = useState(0);
  const [otherText, setOtherText] = useState('');
  const [otherActive, setOtherActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCursor(0);
    setOtherText('');
    setOtherActive(false);
    setSubmitting(false);
    setError(null);
  }, [req.id]);

  async function commit(value: string) {
    if (!q || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await reply({
        kind: 'owner-input',
        requestId: req.id,
        answers: { [q.id]: value },
      });
      setOtherText('');
    } catch {
      setError('reply failed; input retained');
    } finally {
      setSubmitting(false);
    }
  }

  function pick(i: number) {
    if (i < 0 || i >= choices.length) return;
    const v = choices[i];
    if (q?.isOther && v === '__other__') {
      setOtherActive(true);
      setTimeout(() => otherRef.current?.focus(), 50);
      return;
    }
    void commit(v);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (otherActive) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setOtherActive(false);
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setCursor((c) => Math.min(choices.length - 1, c + 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pick(cursor);
      } else if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < choices.length) {
          e.preventDefault();
          pick(i);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cursor, choices, otherActive, req.id]);

  return (
    <div className="slot slot-choice">
      <div className="slot-head">
        <span className="dot" aria-hidden />
        <span className="label">awaits owner — choose one</span>
      </div>
      <div className="slot-q">{q?.question ?? ''}</div>
      <ul className="choices">
        {choices.map((c, i) => {
          const isOtherSentinel = q?.isOther && c === '__other__';
          return (
            <li
              key={i}
              className={`choice ${i === cursor ? 'on' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(i)}
            >
              <span className="num">{i + 1}</span>
              <span className="text">{isOtherSentinel ? 'other…' : c}</span>
            </li>
          );
        })}
      </ul>
      {otherActive ? (
        <div className="slot-row">
          <input
            ref={otherRef}
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && otherText.trim()) void commit(otherText.trim());
              if (e.key === 'Escape') setOtherActive(false);
            }}
            placeholder="custom answer…"
            disabled={submitting}
          />
          <button
            className="slot-send"
            onClick={() => otherText.trim() && void commit(otherText.trim())}
            disabled={!otherText.trim() || submitting}
          >
            {submitting ? 'sending…' : 'send →'}
          </button>
        </div>
      ) : null}
      {error ? <div className="slot-error">{error}</div> : null}
      <div className="slot-hint">
        <kbd>↑</kbd>/<kbd>↓</kbd> nav · <kbd>↵</kbd> confirm · <kbd>1</kbd>–
        <kbd>{choices.length}</kbd> jump
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── multi */

function MultiQuestionSlot({ req, reply }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(req.questions.map((q) => [q.id, ''])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValues(Object.fromEntries(req.questions.map((q) => [q.id, ''])));
    setSubmitting(false);
    setError(null);
    const t = setTimeout(() => firstRef.current?.focus(), 220);
    return () => clearTimeout(t);
  }, [req.id]);

  function set(id: string, v: string) {
    setValues((m) => ({ ...m, [id]: v }));
  }

  const allFilled = req.questions.every((q) => values[q.id]?.trim());

  async function send() {
    if (!allFilled || submitting) return;
    const trimmed = Object.fromEntries(
      req.questions.map((q) => [q.id, (values[q.id] ?? '').trim()]),
    );
    setSubmitting(true);
    setError(null);
    try {
      await reply({ kind: 'owner-input', requestId: req.id, answers: trimmed });
      setValues(Object.fromEntries(req.questions.map((q) => [q.id, ''])));
    } catch {
      setError('reply failed; input retained');
    } finally {
      setSubmitting(false);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="slot slot-multi" onKeyDown={onKey}>
      <div className="slot-head">
        <span className="dot" aria-hidden />
        <span className="label">awaits owner — {req.questions.length} questions</span>
      </div>
      <div className="multi-form">
        {req.questions.map((q, i) => (
          <label key={q.id} className="multi-field">
            <span className="multi-q">
              {q.header ? <span className="multi-header">{q.header}</span> : null}
              {q.question}
            </span>
            <input
              ref={i === 0 ? firstRef : null}
              type={q.isSecret ? 'password' : 'text'}
              value={values[q.id] ?? ''}
              onChange={(e) => set(q.id, e.target.value)}
              placeholder=""
              autoComplete={q.isSecret ? 'new-password' : 'off'}
              disabled={submitting}
            />
          </label>
        ))}
      </div>
      <div className="slot-row">
        <button
          className="slot-send"
          onClick={() => void send()}
          disabled={!allFilled || submitting}
        >
          {submitting ? 'sending…' : `send ${req.questions.length} answers →`}
        </button>
      </div>
      {error ? <div className="slot-error">{error}</div> : null}
      <div className="slot-hint">
        <kbd>tab</kbd>/<kbd>shift+tab</kbd> nav · <kbd>⌘</kbd>+<kbd>↵</kbd> submit
      </div>
    </div>
  );
}
