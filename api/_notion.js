// api/_lib/notion.js — thin wrapper over the Notion REST API for the
// /ops/corkboard builds board. Underscore-prefixed so Vercel does not
// treat it as a function.
//
// Why no SDK: @notionhq/client ships a chunky RPC layer we do not need;
// we only hit four endpoints and the frontend already knows the shape
// of a build card. Keeping it on fetch avoids a 400 KB dependency and
// keeps cold starts lean.
//
// All calls use NOTION_TOKEN and NOTION_BUILDS_DB_ID (Notion internal
// integration; the operator adds both in Vercel env). The integration
// must be shared with the database inside Notion.

const NOTION_VERSION = '2022-06-28';
const BASE = 'https://api.notion.com/v1';

// ─── property shape ──────────────────────────────────────────────

// Build = frontend-friendly flat row. Field names mirror what the UI
// renders, not Notion's internal property keys.
//
//   id             Notion page id (uuid)
//   name           title text
//   status         Idea | Active | In PR | Blocked | Paused | Shipped
//   area           Ops | Wholesale | Participant | Prospecting |
//                  People | Loyalty | Routes | Payments | Infra
//   priority       P0 | P1 | P2
//   nextAction     string
//   blocker        string
//   pr             integer | null
//   prState        OPEN | MERGED | CLOSED | null
//   sessionLink    url | null
//   repoLink       url | null
//   lastTouched    ISO date | null
//   buildId        auto-increment int | null
//   url            notion.so page url

function plainText(rt) {
  if (!Array.isArray(rt)) return '';
  return rt.map(r => r?.plain_text || '').join('').trim();
}

function pageToBuild(page) {
  const p = page.properties || {};
  const pr = p.PR?.number;
  const buildId = p['Build ID']?.unique_id?.number ?? null;
  return {
    id: page.id,
    name: plainText(p.Name?.title),
    status: p.Status?.status?.name || null,
    area: p.Area?.select?.name || null,
    priority: p.Priority?.select?.name || null,
    nextAction: plainText(p['Next Action']?.rich_text),
    blocker: plainText(p.Blocker?.rich_text),
    pr: typeof pr === 'number' ? pr : null,
    prState: p['PR State']?.select?.name || null,
    sessionLink: p['Session Link']?.url || null,
    repoLink: p['Repo Link']?.url || null,
    lastTouched: p['Last Touched']?.date?.start || null,
    buildId,
    url: page.url,
  };
}

// patch = subset of the Build fields above. Convert to Notion property
// writes. Unknown fields are ignored so a stale frontend cannot break
// a save.
function patchToProperties(patch) {
  const props = {};
  if ('name' in patch) {
    props.Name = { title: [{ type: 'text', text: { content: String(patch.name || '') } }] };
  }
  if ('status' in patch) {
    props.Status = patch.status ? { status: { name: patch.status } } : { status: null };
  }
  if ('area' in patch) {
    props.Area = patch.area ? { select: { name: patch.area } } : { select: null };
  }
  if ('priority' in patch) {
    props.Priority = patch.priority ? { select: { name: patch.priority } } : { select: null };
  }
  if ('nextAction' in patch) {
    props['Next Action'] = { rich_text: [{ type: 'text', text: { content: String(patch.nextAction || '') } }] };
  }
  if ('blocker' in patch) {
    props.Blocker = { rich_text: [{ type: 'text', text: { content: String(patch.blocker || '') } }] };
  }
  if ('pr' in patch) {
    props.PR = { number: patch.pr == null ? null : Number(patch.pr) };
  }
  if ('prState' in patch) {
    props['PR State'] = patch.prState ? { select: { name: patch.prState } } : { select: null };
  }
  if ('sessionLink' in patch) {
    props['Session Link'] = { url: patch.sessionLink || null };
  }
  if ('repoLink' in patch) {
    props['Repo Link'] = { url: patch.repoLink || null };
  }
  if ('lastTouched' in patch) {
    props['Last Touched'] = patch.lastTouched ? { date: { start: patch.lastTouched } } : { date: null };
  }
  return props;
}

async function notion(path, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = new Error(`notion ${method} ${path} ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// ─── public functions ────────────────────────────────────────────

async function listBuilds({ db, token }) {
  const out = [];
  let cursor;
  do {
    const data = await notion(`/databases/${db}/query`, {
      token,
      method: 'POST',
      body: {
        page_size: 100,
        start_cursor: cursor,
        sorts: [{ property: 'Last Touched', direction: 'descending' }],
      },
    });
    for (const page of data.results || []) out.push(pageToBuild(page));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function createBuild({ db, token, patch }) {
  const properties = patchToProperties(patch);
  const data = await notion(`/pages`, {
    token,
    method: 'POST',
    body: { parent: { database_id: db }, properties },
  });
  return pageToBuild(data);
}

async function updateBuild({ token, id, patch }) {
  const properties = patchToProperties(patch);
  const data = await notion(`/pages/${id}`, {
    token,
    method: 'PATCH',
    body: { properties },
  });
  return pageToBuild(data);
}

async function archiveBuild({ token, id }) {
  await notion(`/pages/${id}`, {
    token,
    method: 'PATCH',
    body: { archived: true },
  });
  return { ok: true };
}

module.exports = { listBuilds, createBuild, updateBuild, archiveBuild };
