import { useState } from 'react';
import { api, uploadFile } from '../api.js';

/**
 * Formats a byte count for display.
 *
 * @param {number} bytes
 * @returns {string} Human-readable size.
 */
function humanSize(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * File-upload answer control.
 *
 * The file is sent to the server as soon as it is chosen, so what the answer
 * stores is only a reference to what is already saved. That keeps the rest of
 * the flow - autosave, submit - working on plain JSON like every other type.
 *
 * @param {object} props
 * @param {string} props.responseId The in-progress response.
 * @param {object} props.question Question with `config`.
 * @param {{fileId?: string, filename?: string, size?: number}|null} props.value
 * @param {(value: object|null) => void} props.onChange
 * @returns {JSX.Element} The control.
 */
function FileUploadInput({ responseId, question, value, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const formats = question.config?.acceptedFormats ?? [];
  const accept = formats.map((f) => `.${f}`).join(',');
  const limit = question.config?.maxSizeMb ?? 10;

  /**
   * Uploads the chosen file and records the reference it returns.
   *
   * @param {File} file
   */
  const choose = async (file) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const result = await uploadFile(
        `/surveys/responses/${responseId}/answers/${question.id}/file`,
        file,
      );
      onChange(result.value);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Removes the uploaded file. */
  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      await api(`/surveys/responses/${responseId}/answers/${question.id}/file`, {
        method: 'DELETE',
      });
      onChange(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {value?.fileId ? (
        <div className="file-chip">
          <span className="file-name">{value.filename}</span>
          <span className="muted">{humanSize(value.size)}</span>
          <button type="button" className="link" onClick={remove} disabled={busy}>
            Remove
          </button>
        </div>
      ) : (
        <input
          type="file"
          accept={accept || undefined}
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0])}
        />
      )}

      {busy ? <p className="muted" style={{ fontSize: '0.82rem' }}>Uploading...</p> : null}
      {error ? <div className="error" style={{ marginTop: '0.5rem' }}>{error}</div> : null}

      <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.4rem' }}>
        {formats.length ? `Accepted: ${formats.join(', ')}. ` : ''}Up to {limit} MB.
      </p>
    </div>
  );
}

/**
 * Resolves the label for one side of a true/false question.
 *
 * Custom labels are optional. A blank or whitespace-only label falls back to
 * True/False rather than rendering an empty choice, so leaving the field
 * untouched behaves exactly as the default.
 *
 * @param {object} config Question config, possibly holding trueLabel/falseLabel.
 * @param {boolean} side Which side to label.
 * @returns {string} The label to display.
 */
export function booleanLabel(config, side) {
  const custom = side ? config?.trueLabel : config?.falseLabel;
  const trimmed = typeof custom === 'string' ? custom.trim() : '';
  return trimmed || (side ? 'True' : 'False');
}

/**
 * Live character counter for the text inputs.
 *
 * Whitespace counts toward the limit, because the limit is about what was
 * typed. It cannot stand in for an answer though, so a field holding only
 * spaces is called out rather than silently passing as filled.
 *
 * @param {{value: string, max: number}} props
 * @returns {JSX.Element} The counter line.
 */
function CharacterCount({ value, max }) {
  const used = value.length;
  const atCap = used >= max;
  // Warn over 90% so the cap is never a surprise.
  const near = used >= Math.floor(max * 0.9);
  const onlySpaces = used > 0 && value.trim().length === 0;

  return (
    <p
      className={near || onlySpaces ? 'count-warn' : 'muted'}
      style={{ fontSize: '0.8rem', margin: '0.25rem 0 0' }}
    >
      {used} / {max}
      {atCap ? ' - limit reached' : ''}
      {onlySpaces ? ' - spaces alone are not an answer' : ''}
    </p>
  );
}

/**
 * Renders the input for one question, dispatching on its type.
 *
 * Every branch emits the shape the API's normaliser expects, so client and
 * server agree on what an answer looks like.
 *
 * @param {object} props
 * @param {object} props.question Question with `type`, `config`, `options`.
 * @param {*} props.value Current answer value.
 * @param {(value: *) => void} props.onChange Called with the new value.
 * @returns {JSX.Element} The input.
 */
export function QuestionInput({ question, value, onChange, responseId }) {
  const { type, config = {}, options = [] } = question;

  switch (type) {
    case 'file_upload':
      return (
        <FileUploadInput
          responseId={responseId}
          question={question}
          value={value}
          onChange={onChange}
        />
      );

    case 'short_text': {
      const max = Number(config.maxLength ?? 200);
      const text = value?.text ?? '';
      return (
        <>
          <input
            type="text"
            maxLength={max}
            value={text}
            // Belt and braces alongside maxLength: a paste can still exceed it
            // in some browsers, and the server rejects anything over the cap.
            onChange={(e) => onChange({ text: e.target.value.slice(0, max) })}
          />
          <CharacterCount value={text} max={max} />
        </>
      );
    }

    case 'long_text': {
      const max = Number(config.maxLength ?? 2000);
      const text = value?.text ?? '';
      return (
        <>
          <textarea
            rows={6}
            maxLength={max}
            value={text}
            onChange={(e) => onChange({ text: e.target.value.slice(0, max) })}
          />
          <CharacterCount value={text} max={max} />
        </>
      );
    }

    case 'integer': {
      const hasMin = config.min !== undefined && config.min !== null;
      const hasMax = config.max !== undefined && config.max !== null;
      const entered = value?.number;

      // A number input's min/max only bind the spinner - typed and pasted
      // values ignore them entirely - so the range is checked here too.
      const outOfRange =
        typeof entered === 'number' &&
        ((hasMin && entered < Number(config.min)) || (hasMax && entered > Number(config.max)));

      return (
        <>
          <input
            type="number"
            min={hasMin ? config.min : undefined}
            max={hasMax ? config.max : undefined}
            step={config.step ?? 1}
            value={entered ?? ''}
            onChange={(e) =>
              onChange(e.target.value === '' ? null : { number: Number(e.target.value) })
            }
          />
          {hasMin || hasMax ? (
            <p
              className={outOfRange ? 'count-warn' : 'muted'}
              style={{ fontSize: '0.8rem', margin: '0.25rem 0 0' }}
            >
              {hasMin && hasMax
                ? `Enter a whole number between ${config.min} and ${config.max}.`
                : hasMin
                  ? `Enter a whole number of at least ${config.min}.`
                  : `Enter a whole number no greater than ${config.max}.`}
              {outOfRange ? ` ${entered} is outside that range.` : ''}
            </p>
          ) : null}
        </>
      );
    }

    case 'scale': {
      const min = Number(config.min ?? 1);
      const max = Number(config.max ?? 5);
      const points = Array.from({ length: max - min + 1 }, (_, i) => min + i);

      return (
        <>
          <div className="row" role="radiogroup" aria-label={question.prompt}>
            {points.map((point) => (
              <label key={point} className="option-row" style={{ marginBottom: 0 }}>
                <input
                  type="radio"
                  name={question.id}
                  checked={value?.number === point}
                  onChange={() => onChange({ number: point })}
                />
                <span>{point}</span>
              </label>
            ))}
          </div>
          {config.minLabel || config.maxLabel ? (
            <p className="muted" style={{ fontSize: '0.82rem' }}>
              {config.minLabel ?? min} to {config.maxLabel ?? max}
            </p>
          ) : null}
        </>
      );
    }

    case 'boolean':
      return (
        <div className="row" role="radiogroup" aria-label={question.prompt}>
          {[true, false].map((option) => (
            <label key={String(option)} className="option-row" style={{ marginBottom: 0 }}>
              <input
                type="radio"
                name={question.id}
                checked={value?.bool === option}
                onChange={() => onChange({ bool: option })}
              />
              <span>{booleanLabel(config, option)}</span>
            </label>
          ))}
        </div>
      );

    case 'single_choice':
      return (
        <div role="radiogroup" aria-label={question.prompt}>
          {options.map((option) => (
            <label key={option.id} className="option-row">
              <input
                type="radio"
                name={question.id}
                checked={value?.optionId === option.id}
                onChange={() => onChange({ optionId: option.id, other: null })}
              />
              <span>{option.label}</span>
            </label>
          ))}

          {config.allowOther ? (
            <label className="option-row">
              <input
                type="radio"
                name={question.id}
                checked={!!value?.other || (value?.optionId === null && value?.other !== undefined)}
                onChange={() => onChange({ optionId: null, other: '' })}
              />
              <input
                type="text"
                placeholder="Other..."
                maxLength={config.otherMaxLength ?? 200}
                value={value?.other ?? ''}
                onChange={(e) => onChange({ optionId: null, other: e.target.value })}
              />
            </label>
          ) : null}
        </div>
      );

    case 'multi_choice': {
      const selected = value?.optionIds ?? [];
      const other = value?.other ?? '';

      // A limit of 0 is legitimate, so presence is tested rather than truthiness.
      const hasMax = config.maxSelections !== undefined && config.maxSelections !== null;
      const max = hasMax ? Number(config.maxSelections) : null;
      const hasMin = config.minSelections !== undefined && config.minSelections !== null;

      const chosen = selected.length + (other.trim() ? 1 : 0);
      const atCap = hasMax && chosen >= max;

      /**
       * Adds or removes an option, refusing additions once the cap is reached.
       *
       * @param {string} optionId
       */
      const toggle = (optionId) => {
        const isOn = selected.includes(optionId);
        if (!isOn && atCap) return;
        const next = isOn ? selected.filter((id) => id !== optionId) : [...selected, optionId];
        onChange({ optionIds: next, other: value?.other ?? null });
      };

      return (
        <div>
          {options.map((option) => {
            const isOn = selected.includes(option.id);
            return (
              <label
                key={option.id}
                className="option-row"
                style={{ opacity: !isOn && atCap ? 0.5 : 1 }}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={!isOn && atCap}
                  onChange={() => toggle(option.id)}
                />
                <span>{option.label}</span>
              </label>
            );
          })}

          {config.allowOther ? (
            <label className="option-row">
              <span className="muted">Other:</span>
              <input
                type="text"
                maxLength={config.otherMaxLength ?? 200}
                value={other}
                disabled={atCap && !other.trim()}
                onChange={(e) => onChange({ optionIds: selected, other: e.target.value })}
              />
            </label>
          ) : null}

          {hasMax || hasMin ? (
            <p className={atCap ? 'count-warn' : 'muted'} style={{ fontSize: '0.8rem' }}>
              {max === 0
                ? 'No selections allowed on this question.'
                : `${chosen}${hasMax ? ` / ${max}` : ''} selected${
                    hasMin ? `, at least ${config.minSelections} required` : ''
                  }${atCap ? ' - limit reached' : ''}`}
            </p>
          ) : null}
        </div>
      );
    }

    case 'ranking': {
      // The saved order is authoritative; any option missing from it (a newly
      // added one) is appended so the list always covers every option.
      const order = value?.order?.length
        ? [...value.order, ...options.map((o) => o.id).filter((id) => !value.order.includes(id))]
        : options.map((option) => option.id);

      const labels = new Map(options.map((option) => [option.id, option.label]));

      /**
       * Moves one option up or down the ranking.
       *
       * @param {number} from Current index.
       * @param {number} to Destination index.
       */
      const move = (from, to) => {
        if (to < 0 || to >= order.length) return;
        const next = [...order];
        [next[from], next[to]] = [next[to], next[from]];
        onChange({ order: next });
      };

      return (
        <div>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Most important first.
          </p>
          {order.map((optionId, position) => (
            <div key={optionId} className="rank-item">
              <span className="index">{position + 1}</span>
              <span>{labels.get(optionId)}</span>
              <span className="spacer" />
              <button
                type="button"
                onClick={() => move(position, position - 1)}
                disabled={position === 0}
                aria-label={`Move ${labels.get(optionId)} up`}
              >
                Up
              </button>
              <button
                type="button"
                onClick={() => move(position, position + 1)}
                disabled={position === order.length - 1}
                aria-label={`Move ${labels.get(optionId)} down`}
              >
                Down
              </button>
            </div>
          ))}
        </div>
      );
    }

    default:
      return <p className="error">Unsupported question type: {type}</p>;
  }
}
