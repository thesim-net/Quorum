import { useEffect, useState } from 'react';

/**
 * Renders a TOTP enrolment as a QR code plus the plain secret.
 *
 * The QR is drawn client-side from the otpauth:// URI; the secret is always
 * shown alongside it for manual entry into an authenticator app. The qrcode
 * library is loaded on demand so participants never download it.
 *
 * @param {{otpauth: string, secret: string}} props
 * @returns {JSX.Element} The enrolment block.
 */
export function TotpQr({ otpauth, secret }) {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    import('qrcode')
      .then((QRCode) => QRCode.toDataURL(otpauth, { margin: 1, width: 192 }))
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        // The secret below still enrols by hand; a failed QR render is not fatal.
      });
    return () => {
      cancelled = true;
    };
  }, [otpauth]);

  return (
    <div>
      {dataUrl ? (
        <img
          src={dataUrl}
          alt="QR code for authenticator app enrolment"
          width={192}
          height={192}
          style={{ display: 'block', margin: '0.5rem 0', background: '#fff', padding: '0.5rem' }}
        />
      ) : null}
      <p className="muted" style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>
        Scan the QR code with an authenticator app, or enter this secret manually:
      </p>
      <pre className="codeblock">{secret}</pre>
    </div>
  );
}
