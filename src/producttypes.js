// What kind of thing was sold.
//
// Its own file, and a leaf: reservations own this vocabulary, and task
// templates need it to say "only for cruises". Importing it from bookings.js
// would have made a cycle, since bookings.js asks the templates to fire when
// one is created. A list of sixteen strings is not worth a cycle.

export const PRODUCT_TYPES = [
  'cruise', 'hotel', 'resort', 'package', 'tour', 'air', 'rail', 'car',
  'transfer', 'excursion', 'attraction', 'event_ticket', 'insurance',
  'parking', 'visa_passport', 'other',
];
