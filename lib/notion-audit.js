/**
 * lib/notion-audit.js — log every Visibility Index audit run to a Notion DB.
 *
 * Behaviour:
 *   - logAuditStarted()     fires at the top of /api/score (status: audit_started) — captures every submitted handle, including typos and private profiles that fail the scrape
 *   - updateAuditRow()      PATCHes the row by ID later (used by /api/score on success or to record a failure reason in Notes)
 *   - logAuditCompleted()   fallback create when no started row exists (status: audit_completed)
 *   - upsertAuditOnLead()   fires from /api/lead when email is captured (status: email_submitted)
 *   - upsertAuditOnBooking() fires from the Calendly webhook (Phase B - status: walkthrough_booked)
 *
 * Each call is fire-and-forget. Failures never block the user-facing response.
 *
 * One-time Notion setup (do this in your browser, takes 5 min):
 *   1. Open the Notion page where your bug-reports DB already lives.
 *   2. Add a new full-page database called "Visibility Index Audits".
 *   3. Add these columns (exact names matter - they're referenced below):
 *      - Title         (Title)         - we use this for the user's full name + score
 *      - LinkedIn URL  (URL)           - the unique identifier for upsert
 *      - First name    (Text)
 *      - Last name     (Text)
 *      - Headline      (Text)
 *      - Company       (Text)
 *      - Score         (Number)        - 0-100 display score
 *      - Composite     (Number)        - 0-18 raw composite
 *      - Tier          (Select)        - Hidden Gem / Rising Voice / Emerging Authority / Recognised Leader
 *      - Status        (Select)        - audit_completed / email_submitted / walkthrough_booked
 *      - Email         (Email)
 *      - Role          (Text)
 *      - Goal          (Text)
 *      - UTM source    (Text)
 *      - UTM campaign  (Text)
 *      - Click ID      (Text)
 *      - Booked at     (Date)
 *      - Notes         (Text)
 *   4. Open the database menu (⋯) → Connections → Add the same Notion integration
 *      you set up for bug reports. (Same NOTION_TOKEN works for both DBs.)
 *   5. Copy the database ID from the URL: notion.so/[workspace]/[DB_ID]?v=...
 *      (The DB_ID is the 32-char hex string before the ?v= part.)
 *   6. Add to Vercel env vars: NOTION_AUDITS_DATABASE_ID = <that ID>
 *   7. Redeploy.
 *
 * If NOTION_AUDITS_DATABASE_ID is not set, every function in this file silently
 * no-ops. The audit pipeline keeps working; we just lose the persistence layer.
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function envOK() {
  return !!(process.env.NOTION_TOKEN && process.env.NOTION_AUDITS_DATABASE_ID);
}

function authHeaders() {
  return {
    'Authorization':  `Bearer ${process.env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type':   'application/json'
  };
}

// Find an existing audit row by LinkedIn URL. Returns the page ID if found, null otherwise.
async function findAuditByUrl(linkedinUrl) {
  if (!linkedinUrl || !envOK()) return null;
  try {
    const r = await fetch(`${NOTION_API}/databases/${process.env.NOTION_AUDITS_DATABASE_ID}/query`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        filter: {
          property: 'LinkedIn URL',
          url: { equals: linkedinUrl }
        },
        page_size: 1
      })
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.results?.[0]?.id || null;
  } catch (err) {
    console.warn('[notion-audit] find error', err?.message || err);
    return null;
  }
}

// Build a Notion properties object from an audit payload. Used both on create
// and on upsert. Fields with empty/null values are omitted (Notion rejects them).
function buildAuditProperties(p) {
  const props = {};
  const fullName = [p.firstName, p.lastName].filter(Boolean).join(' ') || '(no name)';
  const titleText = p.score !== null && p.score !== undefined
    ? `${fullName} — ${p.score}/100`
    : fullName;

  props['Title']        = { title:     [{ text: { content: titleText.slice(0, 200) } }] };
  if (p.linkedinUrl)    props['LinkedIn URL']  = { url: p.linkedinUrl.slice(0, 500) };
  if (p.firstName)      props['First name']    = { rich_text: [{ text: { content: String(p.firstName).slice(0, 100) } }] };
  if (p.lastName)       props['Last name']     = { rich_text: [{ text: { content: String(p.lastName).slice(0, 100) } }] };
  if (p.headline)       props['Headline']      = { rich_text: [{ text: { content: String(p.headline).slice(0, 500) } }] };
  if (p.company)        props['Company']       = { rich_text: [{ text: { content: String(p.company).slice(0, 200) } }] };
  if (typeof p.score === 'number')     props['Score']     = { number: p.score };
  if (typeof p.composite === 'number') props['Composite'] = { number: p.composite };
  if (p.tier) {
    // Notion's Tier select schema uses bare names (Hidden Gem / Rising Voice /
    // Emerging Authority / Recognised Leader). Our internal TIERS array uses
    // "The X" prefix for display. Strip "The " so we hit the existing select
    // options rather than auto-creating duplicates.
    const tierName = String(p.tier).replace(/^The\s+/i, '').slice(0, 100);
    props['Tier'] = { select: { name: tierName } };
  }
  if (p.status)  props['Status']  = { select: { name: String(p.status).slice(0, 100) } };
  if (p.email)   props['Email']   = { email: String(p.email).slice(0, 200) };
  if (p.role)    props['Role']    = { rich_text: [{ text: { content: String(p.role).slice(0, 100) } }] };
  if (p.goal)    props['Goal']    = { rich_text: [{ text: { content: String(p.goal).slice(0, 100) } }] };
  if (p.utmSource)     props['UTM source']    = { rich_text: [{ text: { content: String(p.utmSource).slice(0, 200) } }] };
  if (p.utmCampaign)   props['UTM campaign']  = { rich_text: [{ text: { content: String(p.utmCampaign).slice(0, 200) } }] };
  if (p.clickId)       props['Click ID']      = { rich_text: [{ text: { content: String(p.clickId).slice(0, 200) } }] };
  if (p.bookedAt)      props['Booked at']     = { date: { start: p.bookedAt } };
  if (p.notes)         props['Notes']         = { rich_text: [{ text: { content: String(p.notes).slice(0, 1000) } }] };
  return props;
}

// Create a row the moment a user submits a handle, BEFORE we know if the scrape
// will succeed. Returns the new page ID so /api/score can PATCH the same row later
// (success → score + status=audit_completed; failure → Notes with error reason).
// Returns null on any error so callers can fall back to logAuditCompleted.
async function logAuditStarted(payload) {
  if (!envOK()) return null;
  try {
    const props = buildAuditProperties({ ...payload, status: 'audit_started' });
    const r = await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        parent: { database_id: process.env.NOTION_AUDITS_DATABASE_ID },
        properties: props
      })
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn('[notion-audit] start failed', r.status, errText.slice(0, 300));
      return null;
    }
    const data = await r.json().catch(() => null);
    return data?.id || null;
  } catch (err) {
    console.warn('[notion-audit] start error', err?.message || err);
    return null;
  }
}

// PATCH an existing audit row by page ID. Used by /api/score to upgrade the
// audit_started row to audit_completed (or stamp a failure reason into Notes).
// Returns false if pageId is missing so callers can fall back to a fresh create.
async function updateAuditRow(pageId, payload) {
  if (!pageId || !envOK()) return false;
  try {
    const props = buildAuditProperties(payload);
    const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ properties: props })
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn('[notion-audit] patch failed', r.status, errText.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[notion-audit] patch error', err?.message || err);
    return false;
  }
}

// Create a fresh row when an audit completes. Called from /api/score success path.
// Fire-and-forget; never throws.
async function logAuditCompleted(payload) {
  if (!envOK()) return false;
  try {
    const props = buildAuditProperties({ ...payload, status: 'audit_completed' });
    const r = await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        parent: { database_id: process.env.NOTION_AUDITS_DATABASE_ID },
        properties: props
      })
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn('[notion-audit] create failed', r.status, errText.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[notion-audit] create error', err?.message || err);
    return false;
  }
}

// Update an existing row when the user submits their email. If no row exists
// (e.g. /api/score failed to log earlier), CREATE one as a fallback.
async function upsertAuditOnLead(payload) {
  if (!envOK()) return false;
  try {
    const props = buildAuditProperties({ ...payload, status: 'email_submitted' });
    const existingId = await findAuditByUrl(payload.linkedinUrl);
    if (existingId) {
      const r = await fetch(`${NOTION_API}/pages/${existingId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ properties: props })
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.warn('[notion-audit] update failed', r.status, errText.slice(0, 300));
        return false;
      }
      return true;
    }
    // Fallback: row didn't exist (audit logging skipped, race, etc.) - create now
    return await logAuditCompleted({ ...payload, status: 'email_submitted' });
  } catch (err) {
    console.warn('[notion-audit] upsert error', err?.message || err);
    return false;
  }
}

// Update an existing row when a Calendly booking confirms. Called from the
// Phase-B Calendly webhook handler (when shipped). Same fallback logic.
async function upsertAuditOnBooking(payload) {
  if (!envOK()) return false;
  try {
    const props = buildAuditProperties({ ...payload, status: 'walkthrough_booked' });
    const existingId = await findAuditByUrl(payload.linkedinUrl);
    if (existingId) {
      const r = await fetch(`${NOTION_API}/pages/${existingId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ properties: props })
      });
      if (!r.ok) return false;
      return true;
    }
    return await logAuditCompleted({ ...payload, status: 'walkthrough_booked' });
  } catch (err) {
    console.warn('[notion-audit] booking upsert error', err?.message || err);
    return false;
  }
}

export { logAuditStarted, updateAuditRow, logAuditCompleted, upsertAuditOnLead, upsertAuditOnBooking };
