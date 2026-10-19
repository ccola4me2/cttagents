// The kinds of section a quick proposal can hold, in the order the editor offers them. The key is what is
// stored and the words are what the client reads above the heading. Its own file so the page a client opens
// and the advisor's editor read the same list without one importing the other.

export const SECTION_KINDS = [
  ['cruise', 'Cruise'], ['cabins', 'Cabin options'], ['hotel', 'Hotel or resort'], ['flights', 'Flights'],
  ['tour', 'Tour or excursion'], ['transfers', 'Transfers'], ['dining', 'Dining and drinks'],
  ['insurance', 'Travel protection'], ['info', 'Good to know'], ['other', 'Something else'],
];
