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

/**
 * Dark enough to read, and to be read on.
 *
 * The agency's colour is not a decoration. On a client's trip page it paints
 * every heading, the departure and return dates, the cabin, the confirmation
 * number, and a badge that writes white text on top of it. On the join page it
 * paints the header band and every field label. Nothing has ever checked that
 * somebody can see any of it.
 *
 * So an agency owner who types a pale brand colour, and a gold or a sky blue is
 * an ordinary thing for a travel agency to have, publishes a trip page whose
 * dates and cabin number are not legible and whose badge is white on cream.
 * Their clients get it, and nobody in the agency is looking at that page.
 *
 * The test is the WCAG AA contrast ratio against white, 4.5:1, which is what
 * the rest of both palettes is built to. A colour that fails keeps the portal's
 * own, and the agency still gets its name, its logo and its tagline on every
 * page: unbranded and readable beats branded and not.
 */
export function readableOnWhite(hex) {
  if (!HEX_COLOR.test(hex || '')) return false;
  const h = hex.slice(1);
  const lum = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0);
  return 1.05 / (lum + 0.05) >= 4.5;
}

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
    color: readableOnWhite(agency.brand_color) ? agency.brand_color : DEFAULT_BRAND.color,
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
