import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

/**
 * Copy for each attestation state: a glyph, a heading, and an honest sentence
 * about what the state does and does not mean.
 */
const STATES = {
  verified: {
    cls: 'ok',
    glyph: '✓',
    title: 'Official build, provenance verified',
    line: 'This deployment is running an official published image whose build provenance is signed and recorded on GitHub.',
  },
  unverified: {
    cls: 'warn',
    glyph: '⚠',
    title: 'Build not verified',
    line: 'The running image has no matching build-provenance attestation. It may be a modified or unofficial build. Treat it with caution and verify independently below.',
  },
  unknown: {
    cls: 'muted',
    glyph: '?',
    title: 'Verification unavailable',
    line: 'The provenance could not be checked right now (GitHub or the registry was unreachable). This is not a failure of the build itself. Try the independent check below.',
  },
  local: {
    cls: 'muted',
    glyph: '•',
    title: 'Local development build',
    line: 'This is a build made outside the release pipeline, so there is no published artifact to verify it against. Official releases are signed and verifiable.',
  },
};

/**
 * Public build-verification page.
 *
 * Shows whether the running deployment is an official signed build, and hands
 * out the exact command to verify it independently. The in-page result is the
 * server reporting on itself, which is an honest signal for a deployment you
 * trust but cannot be proof against one you do not: only the independent check,
 * run outside this server, is proof. The page says so plainly.
 *
 * @returns {JSX.Element} The page.
 */
export function Verify() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api('/attestation')
      .then(setStatus)
      .catch(() => setError(true));
  }, []);

  /** Builds the block copied by "Copy Attestation": both commands and the link. */
  const attestationText = (s) =>
    [
      "Verify Quorum's published build provenance (needs the GitHub CLI):",
      '',
      s.verify.api,
      s.verify.web,
      '',
      `Attestations: ${s.attestationUrl}`,
    ].join('\n');

  /** Copies the verification commands and link to the clipboard. */
  const copy = async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(attestationText(status));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied or unavailable. The commands are shown above to copy
      // by hand, so a failure here must not disturb the loaded page.
    }
  };

  if (error) {
    return (
      <div className="shell prose">
        <p>
          <Link to="/">Back</Link>
        </p>
        <h1>Build verification</h1>
        <p className="error">Could not load the build status.</p>
      </div>
    );
  }

  if (!status) {
    return <div className="shell muted">Loading...</div>;
  }

  const meta = STATES[status.state] ?? STATES.unknown;
  const shortSha = status.commit && status.commit !== 'unknown' ? status.commit.slice(0, 7) : null;

  return (
    <div className="shell prose">
      <p>
        <Link to="/">Back</Link>
      </p>
      <h1>Build verification</h1>

      <div className={`verify-status verify-${meta.cls}`}>
        <span className="verify-glyph" aria-hidden="true">
          {meta.glyph}
        </span>
        <div>
          <strong>{meta.title}</strong>
          <p>{meta.line}</p>
        </div>
      </div>

      <h2>What is running</h2>
      <ul>
        <li>
          <strong>Version:</strong> {status.version}
        </li>
        <li>
          <strong>Commit:</strong>{' '}
          {shortSha ? (
            <a href={`https://github.com/${status.repo}/commit/${status.commit}`} target="_blank" rel="noreferrer">
              <code>{shortSha}</code>
            </a>
          ) : (
            <code>unknown</code>
          )}
        </li>
        <li>
          <strong>Image:</strong> <code>{status.image}</code>
        </li>
        {status.digest ? (
          <li>
            <strong>Digest:</strong> <code className="verify-digest">{status.digest}</code>
          </li>
        ) : null}
      </ul>

      <h2>Verify it yourself</h2>
      <p>
        The result above is this server reporting on itself. That is a useful signal for a
        deployment you already trust, and it will flag an unofficial or drifted image. It is not
        proof for a deployment you do not control, because the same server draws this page. The real
        proof is the command below, run on your own machine against the published image, before this
        server is ever involved. Quorum ships as two images, so there are two commands: one for the
        backend, one for the frontend served to browsers.
      </p>
      <p className="verify-cmd-label">
        Backend (<code>quorum-api</code>):
      </p>
      <pre className="codeblock">{status.verify.api}</pre>
      <p className="verify-cmd-label">
        Frontend (<code>quorum-web</code>):
      </p>
      <pre className="codeblock">{status.verify.web}</pre>
      <p className="verify-actions">
        <button type="button" onClick={copy}>
          {copied ? 'Copied' : 'Copy Attestation'}
        </button>
        <a href={status.attestationUrl} target="_blank" rel="noreferrer">
          View attestations on GitHub
        </a>
      </p>

      <h2>Plugins</h2>
      <p className="muted">
        Enabling a built-in plugin is a setting stored in the database; it does not change the image,
        so it never affects the build verification above.
      </p>
      {status.plugins.official.length ? (
        <ul>
          {status.plugins.official.map((p) => (
            <li key={p.key}>{p.name}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No plugins are enabled.</p>
      )}
      {status.plugins.custom.length ? (
        <>
          <h3>Custom plugins</h3>
          <p>
            This deployment is also running plugins that are not part of the official build. They are
            not covered by the verification above:
          </p>
          <ul>
            {status.plugins.custom.map((key) => (
              <li key={key}>
                <code>{key}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
