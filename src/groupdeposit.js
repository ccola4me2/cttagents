// What a group asks down to hold a cabin: the standard deposit, and a higher one for a suite when the supplier wants one.
//
// A suite is a cabin whose name says so ("Grand Terrace Suite", "Serene Junior Suite"). A group with no suite deposit set asks the
// standard deposit of every cabin, so a group made before there were two amounts is unchanged.

export const isSuite = (roomType) => /\bsuites?\b/i.test(String(roomType || ''));

/** The deposit per guest, in cents, for a cabin of this name. */
export function depositPerGuestFor(group, roomType) {
  const standard = Number(group && group.deposit_per_guest_cents) || 0;
  const suite = Number(group && group.suite_deposit_per_guest_cents) || 0;
  return isSuite(roomType) && suite > 0 ? suite : standard;
}
