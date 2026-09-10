// The remaining CTT Tools areas, grouped into a few coherent endpoints
// rather than one route per upstream resource.
//
// Every section is fetched independently and allowed to fail on its own. These
// pages pull from many resources at once, and one unavailable area should cost
// its own panel rather than the whole screen.

import { json, badRequest, clean } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';

/** Runs the named loaders in parallel, never throwing. */
async function gather(entries) {
  const out = {};
  const unavailable = {};
  const settled = await Promise.all(
    entries.map(async ([key, run]) => {
      try { return [key, await run(), null]; }
      catch (e) { return [key, null, e]; }
    })
  );
  for (const [key, value, err] of settled) {
    out[key] = value ?? (Array.isArray(value) ? [] : null);
    if (err) { out[key] = Array.isArray(out[key]) ? [] : null; unavailable[key] = true; }
  }
  return { out, unavailable };
}

export async function handleMarketing(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);

  const { out, unavailable } = await gather([
    ['funnels', () => ghl.listFunnels(env, loc)],
    ['campaigns', () => ghl.listCampaigns(env, loc)],
    ['emailTemplates', () => ghl.listEmailTemplates(env, loc)],
    ['triggerLinks', () => ghl.listTriggerLinks(env, loc)],
    ['socialAccounts', () => ghl.listSocialAccounts(env, loc)],
    ['socialPosts', () => ghl.listSocialPosts(env, loc)],
    ['blogSites', () => ghl.listBlogSites(env, loc)],
  ]);

  // Blog posts need a site id, so they can only be fetched once sites are in.
  let blogPosts = [];
  if (Array.isArray(out.blogSites) && out.blogSites.length) {
    blogPosts = await ghl.listBlogPosts(env, loc, out.blogSites[0].id).catch(() => []);
  }

  return json({ ...out, blogPosts, unavailable });
}

export async function handleCatalog(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);

  const { out, unavailable } = await gather([
    ['products', () => ghl.listProducts(env, loc)],
  ]);

  // Prices hang off each product. Cap the fan-out so a large catalogue does
  // not fire a hundred requests and trip the rate limit.
  const products = out.products || [];
  const withPrices = await Promise.all(
    products.slice(0, 25).map(async (p) => ({
      ...p,
      prices: await ghl.listProductPrices(env, loc, p.id).catch(() => []),
    }))
  );
  const rest = products.slice(25).map((p) => ({ ...p, prices: [] }));

  return json({ products: [...withPrices, ...rest], unavailable });
}

export async function handleLibrary(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);
  const { out, unavailable } = await gather([['files', () => ghl.listMedia(env, loc)]]);
  return json({ files: out.files || [], unavailable });
}

export async function handleAccount(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);

  const { out, unavailable } = await gather([
    ['location', () => ghl.getLocation(env, loc)],
    ['users', () => ghl.listUsers(env, loc)],
    ['customFields', () => ghl.listCustomFields(env, loc)],
    ['customValues', () => ghl.listCustomValues(env, loc)],
    ['tags', () => ghl.listTags(env, loc)],
    ['customObjects', () => ghl.listCustomObjects(env, loc)],
    ['businesses', () => ghl.listBusinesses(env, loc)],
  ]);
  return json({ ...out, unavailable });
}

export async function handleSurveys(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);
  const url = new URL(request.url);

  try {
    const [surveys, submissions] = await Promise.all([
      ghl.listSurveys(env, loc),
      ghl.listSurveySubmissions(env, loc, {
        surveyId: url.searchParams.get('surveyId') || undefined,
        q: url.searchParams.get('q') || undefined,
      }),
    ]);
    const byId = new Map(surveys.map((sv) => [sv.id, sv.name]));
    for (const sub of submissions.submissions) sub.surveyName = byId.get(sub.surveyId) || '';
    return json({ surveys, ...submissions });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

// ---------------------------------------------------------------------------
// Writes
//
// Every handler here resolves the location from the signed-in user and never
// from the request. Three authorization bugs in this codebase have all been
// the same shape: a scope check present on one handler and missing on its
// neighbour, so the rule is that the location is derived, never supplied.
// ---------------------------------------------------------------------------
import { oneOf, toCents, readJson } from './util.js';
import * as db from './db.js';

/**
 * Add a file to the media library, from here rather than from the CRM.
 *
 * Uploaded straight through to GoHighLevel, because that is where the library
 * lives and where a campaign or a social post will look for it. Keeping a copy
 * here as well would be a second library to keep in step with the first.
 */
export async function handleUploadMedia(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  let form;
  try { form = await request.formData(); } catch { form = null; }
  const file = form && form.get('file');
  if (!file || typeof file === 'string') return badRequest('Choose a file to upload.');

  // Twenty-five megabytes, which is what the library accepts. Refused here
  // with a sentence rather than there with a status code.
  const MAX = 25 * 1024 * 1024;
  if (file.size > MAX) {
    return badRequest(`That file is ${Math.round(file.size / 1024 / 1024)}MB. The library takes 25MB.`);
  }
  if (!file.size) return badRequest('That file is empty.');

  const name = clean(form.get('name'), 200) || file.name || 'upload';

  try {
    const saved = await ghl.uploadMedia(env, ghl.locationFor(env, user), file, name);
    await db.logActivity(env, user.id, 'media.upload', `Uploaded ${name}`, { id: saved.id });
    return json({ ok: true, ...saved, name });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateSocialPost(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const summary = clean(body.summary, 2000);
  const accountIds = Array.isArray(body.accountIds)
    ? body.accountIds.map((a) => clean(a, 64)).filter(Boolean).slice(0, 20)
    : [];

  if (!summary) return badRequest('Write something to post.');
  if (!accountIds.length) return badRequest('Choose at least one account to post to.');

  // A schedule in the past would publish immediately, which is rarely what
  // someone picking a date meant.
  const scheduleDate = clean(body.scheduleDate, 40);
  if (scheduleDate && Date.parse(scheduleDate) < Date.now() - 60000) {
    return badRequest('That time is in the past.');
  }

  try {
    const post = await ghl.createSocialPost(env, ghl.locationFor(env, user), {
      accountIds, summary, scheduleDate: scheduleDate || undefined,
    });
    await db.logActivity(env, user.id, 'social.create',
      scheduleDate ? 'Scheduled a social post' : 'Created a social post', { id: post.id });
    return json({ ok: true, post }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateProduct(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 160);
  if (!name) return badRequest('Give the product a name.');

  const locationId = ghl.locationFor(env, user);
  try {
    const product = await ghl.createProduct(env, locationId, {
      name,
      description: clean(body.description, 2000),
      productType: oneOf(body.productType, ['SERVICE', 'PHYSICAL', 'DIGITAL']).toUpperCase(),
    });

    // A price is optional, but a product without one cannot be sold, so it is
    // created in the same step rather than left as a second thing to remember.
    let price = null;
    const amountCents = toCents(body.amount);
    if (product?.id && amountCents > 0) {
      price = await ghl.createProductPrice(env, locationId, product.id, {
        name: clean(body.priceName, 80) || name,
        amount: amountCents / 100,
        type: oneOf(body.priceType, ['one_time', 'recurring']),
      }).catch(() => null);
    }

    await db.logActivity(env, user.id, 'product.create', `Added product ${name}`, { id: product?.id });
    return json({ ok: true, product, price }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateAccountItem(request, env, kind) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 120);
  if (!name) return badRequest('Enter a name.');

  const locationId = ghl.locationFor(env, user);
  try {
    let created;
    if (kind === 'tags') {
      created = await ghl.createTag(env, locationId, name);
    } else if (kind === 'custom-values') {
      const value = clean(body.value, 2000);
      if (!value) return badRequest('Enter a value.');
      created = await ghl.createCustomValue(env, locationId, { name, value });
    } else if (kind === 'custom-fields') {
      created = await ghl.createCustomField(env, locationId, {
        name,
        dataType: oneOf(body.dataType, ['TEXT', 'LARGE_TEXT', 'NUMERICAL', 'PHONE', 'MONETORY', 'DATE', 'CHECKBOX']).toUpperCase(),
      });
    } else {
      return badRequest('Unknown item type.');
    }
    await db.logActivity(env, user.id, `account.${kind}`, `Added ${name}`, { kind });
    return json({ ok: true, created }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
