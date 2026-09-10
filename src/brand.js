// Who an agency is, for anything that has to say so.
//
// A leaf, and deliberately: auth.js needs to look an agency up to attach a new
// advisor to it, and agencies.js needs auth.js to know who is asking. Putting
// the lookups with the handlers made a cycle, and a cycle here is not a style
// point: whichever module the bundler reaches second gets a binding that is
// still in its temporal dead zone, and sign-in throws.
//
// So the reads live here and import nothing. The handlers live in agencies.js
// and import this.

export const AGENCY_COLUMNS = `
  id, name, slug, ghl_location_id, address, phone, email, website,
  seller_of_travel, logo_url, brand_color, tagline, join_open,
  created_at, updated_at
`;

// What a page looks like when nobody has said otherwise: the portal's own
// colours, so an agency that fills in nothing still gets a finished page
// rather than a broken one.
export const DEFAULT_BRAND = {
  name: 'Cruises Tours & Travel',
  tagline: '',
  logoUrl: null,
  color: '#12315e',
};

// Six hex digits after a hash, and nothing else. This value is interpolated
// into a style attribute on pages that strangers read, so anything not
// unmistakably a colour does not go in.
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export async function getAgency(env, id) {
  if (!id) return null;
  return env.DB.prepare(`SELECT ${AGENCY_COLUMNS} FROM agencies WHERE id = ?`).bind(id).first();
}

export async function getAgencyBySlug(env, slug) {
  if (!slug) return null;
  return env.DB.prepare(`SELECT ${AGENCY_COLUMNS} FROM agencies WHERE slug = ?`)
    .bind(slug).first();
}

/** The agency a new advisor lands in when they arrive at /signup with no link. */
export async function houseAgency(env) {
  return env.DB.prepare(`SELECT ${AGENCY_COLUMNS} FROM agencies ORDER BY created_at ASC LIMIT 1`)
    .first();
}

/** What to put on a page or an email. Never throws, never returns nothing. */
export function brandOf(agency) {
  if (!agency) return { ...DEFAULT_BRAND };
  return {
    name: agency.name || DEFAULT_BRAND.name,
    tagline: agency.tagline || DEFAULT_BRAND.tagline,
    logoUrl: agency.logo_url || null,
    color: HEX_COLOR.test(agency.brand_color || '') ? agency.brand_color : DEFAULT_BRAND.color,
  };
}

/**
 * The branding for whoever owns a record.
 *
 * Best effort by design. Every caller is rendering something for somebody
 * outside the business: a client opening their trip page should see the
 * agency's name, and if this lookup fails they should still see a page.
 */
export async function brandForUser(env, userId) {
  if (!userId) return { ...DEFAULT_BRAND };
  try {
    const row = await env.DB.prepare(
      'SELECT a.* FROM users u JOIN agencies a ON a.id = u.agency_id WHERE u.id = ?'
    ).bind(userId).first();
    return brandOf(row);
  } catch {
    return { ...DEFAULT_BRAND };
  }
}
