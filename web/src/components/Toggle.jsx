/**
 * A labelled checkbox with an optional line of explanation under it.
 *
 * Shared rather than redeclared: the survey editor and the group editor both
 * ask yes/no questions that need a sentence of consequence attached, and they
 * have to look and read the same when they do.
 *
 * @param {{checked: boolean, onChange: (v: boolean) => void, label: string,
 *   hint?: string, disabled?: boolean}} props
 * @returns {JSX.Element} The toggle.
 */
export function Toggle({ checked, onChange, label, hint, disabled = false }) {
  return (
    <label className="option-row" style={{ alignItems: 'flex-start' }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint ? (
          <>
            <br />
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              {hint}
            </span>
          </>
        ) : null}
      </span>
    </label>
  );
}
