import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

/**
 * Plugin management: enable or disable each plugin globally.
 *
 * A plugin an open survey depends on cannot be turned off; the server refuses
 * and the surveys using it are listed here so the admin knows why.
 *
 * @returns {JSX.Element} The page.
 */
export function Plugins() {
  const [plugins, setPlugins] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);

  /**
   * Reloads the plugin list.
   *
   * @returns {Promise<void>}
   */
  const load = () =>
    api('/admin/plugins')
      .then((data) => setPlugins(data.plugins))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  /**
   * Flips one plugin's enablement.
   *
   * @param {object} plugin The plugin being toggled.
   */
  const toggle = async (plugin) => {
    setError(null);
    setStatus(null);
    setBusy(plugin.key);

    const next = {};
    for (const entry of plugins) next[entry.key] = entry.key === plugin.key ? !entry.enabled : entry.enabled;

    try {
      await api('/admin/plugins', { method: 'PUT', body: { plugins: next } });
      setStatus(`${plugin.name} ${plugin.enabled ? 'disabled' : 'enabled'}.`);
      await load();
    } catch (e) {
      // The server blocks disabling a plugin an open survey depends on.
      if (e.payload?.activeSurveys) {
        setError(
          `${e.message} In use by: ${e.payload.activeSurveys.map((s) => s.title).join(', ')}.`,
        );
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(null);
    }
  };

  if (!plugins) return <div className="shell muted">Loading...</div>;

  return (
    <div className="shell">
      <p>
        <Link to="/admin">Back to admin</Link>
      </p>
      <h1>Plugins</h1>
      <p className="muted">
        Enable a plugin to make it available to your surveys. A plugin cannot be turned off while an
        open survey depends on it.
      </p>

      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}

      {plugins.map((plugin) => (
        <div className="card" key={plugin.key}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div className="row">
                <strong>{plugin.name}</strong>
                {plugin.enabled ? (
                  <span className="badge badge-live">Enabled</span>
                ) : (
                  <span className="badge">Disabled</span>
                )}
              </div>
              <p className="muted" style={{ margin: '0.3rem 0 0', fontSize: '0.9rem' }}>
                {plugin.detail}
              </p>
              {plugin.activeSurveys.length > 0 ? (
                <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 0 }}>
                  In use by {plugin.activeSurveys.length} open survey
                  {plugin.activeSurveys.length === 1 ? '' : 's'}:{' '}
                  {plugin.activeSurveys.map((s) => s.title).join(', ')}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className={plugin.enabled ? '' : 'primary'}
              disabled={busy === plugin.key}
              onClick={() => toggle(plugin)}
            >
              {busy === plugin.key ? '...' : plugin.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
