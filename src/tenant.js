// Which tenant a user's records belong to.
//
// `automations`, `automation_runs` and `forms` are partitioned by a key called
// `location_id`, and the value came from GoHighLevel: it was the sub-account an
// advisor worked in. GoHighLevel is gone, but the key is still the key, and the
// rows still carry the values it handed out.
//
// So the name moves here and the storage does not. Renaming `location_id` on
// four tables and `ghl_location_id` on two is a migration that changes no
// behaviour, on a live database, to make a word match: the risk is real and the
// benefit is a word. The column names are left alone on purpose, and this is
// the note that says so rather than a reader having to work it out.
//
// The data fence is `agency_id` and always was. This is a partition key, not a
// permission. See scopeWhere in db.js for the one that decides who sees what.

/** The tenant this user's automations and forms belong to. */
export function tenantFor(env, user) {
  return (user && user.ghl_location_id) || env.GHL_DEFAULT_LOCATION_ID || '';
}
