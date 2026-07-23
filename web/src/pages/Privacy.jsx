import { Link } from 'react-router-dom';

/**
 * Public data-privacy page.
 *
 * Describes exactly what the deployment can collect, why, how it is stored, and
 * when it is anonymised. Reachable without signing in, because someone deciding
 * whether to take part should be able to read it first.
 *
 * The per-survey toggles mean any individual survey may collect less than this;
 * its intro screen states what that particular survey collects before the first
 * question. This page is the full picture of what is possible.
 *
 * @returns {JSX.Element} The page.
 */
export function Privacy() {
  return (
    <div className="shell prose">
      <p>
        <Link to="/">Back</Link>
      </p>
      <h1>Data privacy</h1>
      <p className="muted">
        This is a self-hosted survey tool for our Discord community. It runs on our own
        infrastructure and sends nothing to third parties. Below is everything it is capable of
        collecting, why, and how long it keeps it. Each individual survey may collect less, and
        tells you exactly what it collects before you answer a single question.
      </p>

      <h2>Signing in</h2>
      <p>
        You sign in with Discord so we can confirm you are a member of our server, since these
        surveys are only for our community. We ask Discord only for the <code>identify</code>{' '}
        permission.
      </p>
      <ul>
        <li>
          <strong>What:</strong> your Discord user ID, username, display name, and avatar.
        </li>
        <li>
          <strong>Why:</strong> to verify server membership, to apply any role or channel
          restrictions on a survey, and to show your name in the corner while you are signed in.
        </li>
        <li>
          <strong>How it is stored:</strong> in our database, updated each time you sign in. Your
          session is a signed, http-only cookie that expires on its own; it holds no personal data
          itself.
        </li>
      </ul>

      <h2>When you answer a survey</h2>

      <h3>A pseudonymous fingerprint (always)</h3>
      <p>
        For every response we store a one-way fingerprint derived from your Discord ID and a key
        unique to that survey. We <strong>never</strong> store your raw ID against a response
        unless the survey explicitly records usernames (below).
      </p>
      <ul>
        <li>
          <strong>Why:</strong> so you can only submit once, and so you can come back and edit your
          answers if the survey allows it.
        </li>
        <li>
          <strong>What it protects:</strong> because the key is different for every survey, the
          same person produces a different fingerprint each time. Nobody with database access can
          link your answers across surveys.
        </li>
      </ul>

      <h3>Your username (only if the survey says so)</h3>
      <ul>
        <li>
          <strong>What:</strong> which member submitted each response.
        </li>
        <li>
          <strong>Why:</strong> some surveys need attributable answers; most do not. This is off by
          default and disclosed on the survey&rsquo;s intro screen when it is on.
        </li>
      </ul>

      <h3>Time spent (only if the survey says so)</h3>
      <ul>
        <li>
          <strong>What:</strong> how long you spend on each question and the survey overall,
          measured by the server as you move through it.
        </li>
        <li>
          <strong>Why:</strong> to understand which questions are hard or unclear. It is kept only
          as a per-question total; the moment-to-moment record is discarded the instant you submit.
        </li>
      </ul>

      <h3>Country (only if the survey says so)</h3>
      <ul>
        <li>
          <strong>What:</strong> the country you answered from. Country only, never a region,
          city, or precise location.
        </li>
        <li>
          <strong>Why:</strong> to see the geographic spread of responses.
        </li>
        <li>
          <strong>How it is stored:</strong> your IP address is looked up on our own server and{' '}
          <strong>immediately discarded</strong>. Only the two-letter country code is kept. The IP
          address itself is never written down.
        </li>
      </ul>

      <h3>File attachments (only if a question asks for one)</h3>
      <ul>
        <li>
          <strong>What:</strong> files you choose to upload in answer to a question that requests
          them, within the size and format limits that question shows.
        </li>
        <li>
          <strong>Why:</strong> some questions need a document, image, or screenshot rather than
          text.
        </li>
        <li>
          <strong>How it is stored:</strong> on our own server&rsquo;s disk, under a random name.
          They are visible only to survey administrators and are deleted when the survey is deleted.
          We check the size and inspect each file&rsquo;s headers to verify it is the type it claims
          to be. Files cannot be opened on the server&rsquo;s filesystem, except to verify those
          headers.
        </li>
      </ul>

      <h2>How your answers become anonymous</h2>
      <p>An administrator can, at any time, permanently anonymise a survey. When they do:</p>
      <ul>
        <li>the survey&rsquo;s key is thrown away and every fingerprint replaced with random data;</li>
        <li>any recorded usernames are erased.</li>
      </ul>
      <p>
        After that, the answers remain but cannot be traced back to anyone, including by us. This is
        irreversible.
      </p>

      <h2>A note on Discord</h2>
      <p>
        We may use Discord to discuss survey results privately among administrators. Discord is not
        a third-party service in this context, because this whole tool already relies on Discord to
        sign you in. Anything Discord itself collects, such as your IP address and your Discord name
        and user ID, it already collects the moment you use Discord at all, independently of these
        surveys.
      </p>
      <p>
        We may discuss the results of those surveys privately in an effort to provide better service
        to the community. This is likely well understood, but we did not want to miss mentioning it
        to our community survey participants.
      </p>

      <h2>Optional features</h2>
      <p>
        The community may switch on optional features. Where one affects your data, here is what it
        does:
      </p>
      <ul>
        <li>
          <strong>Announcements and reminders:</strong> a survey&rsquo;s link, and when it closes a
          count of how many people took part, may be posted to a Discord channel. This is only ever
          an aggregate count. Your individual answers are never posted.
        </li>
        <li>
          <strong>Raffle:</strong> an administrator may draw a random respondent as a prize winner.
          On a survey that records usernames this surfaces the winner&rsquo;s name; on an anonymous
          survey it reveals only a response number, never who it was.
        </li>
        <li>
          <strong>Conditional questions:</strong> a survey may hide questions that do not apply to
          you based on an earlier answer. Anything you typed into a question that later became
          hidden is discarded rather than submitted.
        </li>
      </ul>

      <h2>What we never do</h2>
      <ul>
        <li>Store your IP address on this survey tool.</li>
        <li>
          Send your data to a third-party service. Discord, which this tool is built on, is not a
          third party here.
        </li>
        <li>Track you across other sites, or load anything from other sites while you use this one.</li>
        <li>Correlate your answers between different surveys.</li>
      </ul>

      <p className="muted">
        Questions about any of this are best raised with the administrators of our Discord server.
      </p>
    </div>
  );
}
