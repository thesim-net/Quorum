import { LinkDiscord } from './LinkDiscord.jsx';
import { SetCredentials } from './SetCredentials.jsx';

// Every step the flow knows about, in the order the server asks for them.
const STEP_LABELS = {
  credentials: 'Set a username and password',
  discord_link: 'Link your Discord account',
};

/**
 * The forced "finish setting up your account" flow.
 *
 * Setting credentials and linking Discord are two halves of one requirement -
 * every admin holds both identities - so they are shown as one sequence with a
 * fixed order rather than two redirects competing for the admin panel. The
 * server names the outstanding step and the full list it belongs to; a step
 * already satisfied is marked done and never asked for again.
 *
 * @param {{user: object, onSignOut: () => void}} props
 * @returns {JSX.Element} The flow.
 */
export function FinishSetup({ user, onSignOut }) {
  const steps = user.onboardingSteps ?? [];
  const current = steps.indexOf(user.onboardingStep);

  return (
    <div className="shell">
      <div className="card">
        <h1>Finish setting up your account</h1>
        <p className="muted">
          {steps.length > 1
            ? 'Two short steps, once. Both identities live on this one account, so it does not matter which way you sign in afterwards.'
            : 'One short step, once, so you always have a way to sign in.'}
        </p>
        <ol className="muted" style={{ margin: 0, paddingLeft: '1.2rem' }}>
          {steps.map((step, index) => (
            <li key={step} style={{ marginBottom: '0.25rem' }}>
              {STEP_LABELS[step] ?? step}{' '}
              {index < current ? (
                <span className="badge">Done</span>
              ) : index === current ? (
                <span className="badge">Now</span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      {user.onboardingStep === 'discord_link' ? (
        <LinkDiscord forced onSignOut={onSignOut} />
      ) : (
        <SetCredentials user={user} />
      )}
    </div>
  );
}
