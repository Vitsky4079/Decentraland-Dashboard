// Supabase Edge Function: submit-report
//
// Receives a structured bug report from the dashboard's Report form and creates
// a conversation in Intercom (initiated by the reporter's contact) so it lands
// in the support inbox like any chat/email. Holds the Intercom token secret-side
// so it never touches the public front-end.
//
// Flow:
//   1. find-or-create the Intercom contact from the submitted email
//   2. create a conversation "from" that contact with the templated body
//      (+ up to 10 evidence image URLs as attachments)
//
// Deploy:  supabase functions deploy submit-report --no-verify-jwt
// Secret:  supabase secrets set INTERCOM_TOKEN=xxxxxxxx
//
// Notes:
//  - Intercom conversation body is HTML; we build a clean templated message.
//  - Image attachments accept up to 10 URLs. Non-image evidence (e.g. video) is
//    linked inline in the body instead, since the attachments array is images.

const INTERCOM_API = 'https://api.intercom.io';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Turn newline text into HTML paragraphs/line-breaks for the conversation body.
function block(label: string, value: string): string {
  if (!value) return '';
  return `<p><b>${esc(label)}</b><br>${esc(value).replace(/\r?\n/g, '<br>')}</p>`;
}

function isImage(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(url);
}

async function intercom(path: string, method: string, token: string, body?: unknown) {
  const res = await fetch(INTERCOM_API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Intercom-Version': '2.11',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

// Find an existing contact by email, or create one. Returns the contact id.
async function findOrCreateContact(email: string, token: string): Promise<string | null> {
  // Search first (avoids duplicate contacts).
  const search = await intercom('/contacts/search', 'POST', token, {
    query: { field: 'email', operator: '=', value: email },
  });
  if (search.ok && search.data && Array.isArray(search.data.data) && search.data.data.length) {
    return search.data.data[0].id;
  }
  // Create as a lead-style user contact.
  const created = await intercom('/contacts', 'POST', token, { role: 'user', email });
  if (created.ok && created.data && created.data.id) return created.data.id;
  // If creation failed because it already exists, try search once more.
  if (created.status === 409) {
    const retry = await intercom('/contacts/search', 'POST', token, {
      query: { field: 'email', operator: '=', value: email },
    });
    if (retry.ok && retry.data && Array.isArray(retry.data.data) && retry.data.data.length) {
      return retry.data.data[0].id;
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const token = Deno.env.get('INTERCOM_TOKEN');
  if (!token) return json({ error: 'Server not configured (missing INTERCOM_TOKEN).' }, 500);

  let p: any;
  try { p = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const email = String(p.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required.' }, 400);

  const attachments: string[] = Array.isArray(p.attachments) ? p.attachments.filter((u: unknown) => typeof u === 'string') : [];
  const imageUrls = attachments.filter(isImage).slice(0, 10);
  const otherUrls = attachments.filter((u) => !isImage(u));

  // Build the conversation body from the template fields.
  const title = (p.description || 'Bug report').slice(0, 80);
  let body = `<p>🐛 <b>New bug report from the status dashboard</b></p>`;
  body += block('🛠️ Build version', p.build);
  body += block('📂 Area', p.area_label || p.area);
  body += block('📔 Issue description', p.description);
  body += block('👣 Steps to reproduce', p.steps);
  body += block('✔️ Expected result', p.expected);
  body += block('❌ Actual result', p.actual);
  body += block('➗ Reproduction rate', p.reproduction_rate);
  body += block('🖥️ PC specification & notes', p.os_notes);
  body += block('✉️ Reporter email', email);
  if (otherUrls.length) {
    body += `<p><b>📎 Evidence (video/other)</b><br>` +
      otherUrls.map((u) => `<a href="${esc(u)}">${esc(u)}</a>`).join('<br>') + `</p>`;
  }

  // 1. contact
  const contactId = await findOrCreateContact(email, token);
  if (!contactId) return json({ error: 'Could not resolve Intercom contact.' }, 502);

  // 2. conversation
  const convPayload: any = {
    from: { type: 'user', id: contactId },
    body,
  };
  if (imageUrls.length) convPayload.attachment_urls = imageUrls;

  const conv = await intercom('/conversations', 'POST', token, convPayload);
  if (!conv.ok) return json({ error: 'Intercom rejected the conversation.', detail: conv.data }, 502);

  return json({ ok: true, conversation_id: conv.data?.conversation_id || conv.data?.id || null, title });
});
