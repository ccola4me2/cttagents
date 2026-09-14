// Which tenant a user's records belong to.
//
// The tenant is the agency, and the answer is `users.agency_id`. That has been
// the data fence since 2026-09-07; as of 0073_agency_partition.sql it is also
// the partition on `automations`, `automation_runs`, `forms`,
// `form_submissions` and `crm_contacts`, whose `agency_id` column was called
// `location_id` and held a GoHighLevel sub-account id until then.
//
// The old key was wrong in both directions and had been since the CRM went. An
// advisor without a sub-account of their own fell back to one shared default,
// so every such advisor shared a partition and one advisor's automations could
// fire on another's clients; and the cron only ever swept that shared default,
// so an advisor who did have their own got no time based automations at all.
//
// A user with no agency is not a case the portal creates: every sign-up path
// takes one from an agency record, and 0050_agencies.sql put every account that
// predates agencies into the house one. The fallback is here so a row that
// somehow has none lands somewhere real rather than in a partition called
// empty string, which every other such row would share.
const HOUSE = 'agency-house';

/** The agency whose automations, forms and carried-over contacts this user sees. */
export function tenantFor(env, user) {
  return (user && user.agency_id) || HOUSE;
}
