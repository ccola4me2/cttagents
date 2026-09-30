/**
 * The group proposal readers still read what they were written to read.
 *
 * A reader is a pile of patterns written from one document, and the way one
 * breaks is by another being added: a new cruise line's reader that happens to
 * claim a Margaritaville proposal, a fix for one layout that moves a label in
 * another. None of that shows on screen until somebody uploads a real proposal
 * and the dates come out wrong. So this keeps what each reader is known to do,
 * and fails the build if a change undoes it.
 *
 * Two kinds of fixture, and they prove different things.
 *
 * The Margaritaville ones are real: the text of two actual proposals as the PDF
 * reader produced it, with the people in them replaced. They prove the exact
 * reader against the true shape of the document, including its quirks ("A
 * menities", a revision after the proposal number, a cabin row with an extra
 * adult rate and one without).
 *
 * The others are written by hand to look like what other lines print, and they
 * prove something narrower: that the fallback fills a field only from a label
 * that says what it is, never takes one kind of reference for another, and
 * refuses a document that is not a group quote. They do NOT prove it reads any
 * real cruise line's proposal, because none of them is one. The first real
 * document from each line is what does that, and becomes a fixture of the
 * first kind.
 */
import { parseGroupQuote, tidy, FORMATS } from '../src/groupquote.js';
import { cabinRows } from '../src/groupquote-mvas.js';
import { parseDate } from '../src/groupquote-util.js';

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => {
  checks += 1; failures += 1;
  console.log(`  FAIL  ${label}: ${detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::groupquote: ${label}: ${detail}`);
};
const is = (label, got, want) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));

// ------------------------------------------------------------ fixtures ---
const MVAS_4589 = "Jane Advisor Proposal ID: 4589 . Sample Group (10/22/2027) Proposal Date : advisor@example.com Proposal Expires : 2026-10-07 (555) 010 - 0100 Proposal Update Date: Agency: Cruise Planners - Jane Advisor MVAS Specialist: Pat Specialist Margaritaville at Sea\u00ae Group Proposal Form 420 S. Orange Ave., Suite 250, Orlando, Florida 32081 MargaritavilleAtSea.com | (800) 814 - 7100 20250 701 Departure Date: 2027-10-22 Ship: Beachcomber Cabin Fare: $15,689.04 Return Date: 2027-10-29 SailingID 22198 Amenities : $2,814.00 Itinerary: 7-Night Belize & Mexico Number of Staterooms 9 Total Amount: $18,503.04 Departure Port: Galveston Total Passengers: 18 Proposal Details Price Per Guest Room Type Occupancy Type Cabins Guests Guest 1 & 2 Extra Adult Extra Child Taxes/Fees Total Fare Cozy Interiors Double 2 4 $358.98 $183.00 $2,167.92 Picturesque Oceanview Staterooms Double 2 4 $470.58 $183.00 $2,614.32 Breezy Balcony Double 4 8 $758.88 $183.00 $7,535.04 Junior Corner Suite Double 1 2 $1,502.88 $183.00 $3,371.76 Additional Amenities Qty Unit Price Total Amenities TC Credits 1 $75 Onboard Credit (GAP) Per Cabin 9 $0.00 $0.00 Gratuities (Suites) Per Guest/PerNight 2 $25.00 $350.00 Gratuities (Non - Suites) Per Guest/PerNight 16 $22.00 $2,464.00 Important Dates/ Payment Terms Payment Due Date Payment Amount Countersigned Proposal 2026-10-07 $0.00 Rate Hold Deposit (Per Cabin) $50 p/Cabin ($100 for Suites) 2026-10-30 $500.00 Full Deposit $200 p/Full Fare Guest ($400 for Suites) 2027-07-09 $3,000.00 Final 2027-07-24 $15,003.04 ALL TERMS, PRICING AND AMENITIES SET FORTH IN THIS PROPOSAL EXPIRE 7 DAYS AFTER PROPOSAL DATE AND ARE SECURED WITH A HOLD DEPOSIT PAYMENT PROVIDED BY THE HOLD DUE DATE. Jane Advisor Sam Executive SVP Sales & Trade Relations Jane Advisor Proposal ID: 4589 . Sample Group (10/22/2027) Proposal Date : advisor@example.com Proposal Expires : 2026-10-07 (555) 010 - 0100 Proposal Update Date: Agency: Cruise Planners - Jane Advisor MVAS Specialist: Pat Specialist Margaritaville at Sea\u00ae Group Proposal Form 420 S. Orange Ave., Suite 250, Orlando, Florida 32081 MargaritavilleAtSea.com | (800) 814 - 7100 20250 701 GROUP BOOKING TERMS AND CONDITIONS GROUP HOLDS AND DEPOSITS Payment of reservation HOLD amount by the Hold date secures the above committed pricing. For Standard Staterooms, required Hold amount is $50 per stateroom, due 30 days after proposal issue date. For Grand Terrace Suites, Grand Terrace Corner Suites (Islander) or Signature Grand Suites (Islander), Hold amount is $100 pe r suite. CANCELLATION POLICY Cancelled reservations due to nonpayment of balance remaining will result in cabins released into general inventory and subje ct to Cancellation Fees per our Cancellation Policy . Cruise reservations or bookings that are cancelled by the Guest prior to the first day of the Cruise are subject to a cancell ation fee except as otherwise provided in the Cancellation Policy or as otherwise provided or by applicable by law. Cancellation ch arges are subject to change without notice. 2 - 3 NIGHT SAILINGS 4 - 5 NIGHT SAILINGS Schedule Amount Schedule Amount 75 \u2013 61 Days Before Sailing 50% of Full Deposit or 50% of Fare* 90 \u2013 61 Days Before Sailing 50% of Full Deposit or 50% of Fare* 60 \u2013 31 Days Before Sailing 75% of Full Deposit or 50% of Fare* 60 \u2013 31 Days Before Sailing 75% of Full Deposit or 50% of Fare* < 30 Days Before Sailing 100% of Full Deposit or 50% of Fare* < 30 Days Before Sailing 100% of Full Deposit or 50% of Fare* 6 - 7 NIGHT SAILINGS 8+ NIGHT SAILINGS Schedule Amount Schedule Amount 120 \u2013 61 Days Before Sailing 50% of Full Deposit or 50% of Fare* 120 \u2013 61 Days Before Sailing 50% of Full Deposit or 50% of Fare* 60 \u2013 31 Days Before Sailing 75% of Full Deposit or 50% of Fare* 60 \u2013 31 Days Before Sailing 75% of Full Deposit or 50% of Fare* < 30 Days Before Sailing 100% of Full Deposit or 50% of Fare* < 30 Days Before Sailing 100% of Full Deposit or 50% of Fare* GROUP INVENTORY REVIEW PROCESS Margaritaville at Sea may contact you at any time to review the status of any unsold inventory. During this review, unsold in ventory without attached legal names and secured by full deposit may be recalled. Margaritaville at Sea reserves the right to immed iately recall any unsold inventory if the sailing is at risk of being oversold. Groups reserved on dates that are not deemed at risk of oversold capacity may have up to seven (7) days to provide legal names and full deposit payments prior to being reclaime d into general inventory. Jane Advisor Proposal ID: 4589 . Sample Group (10/22/2027) Proposal Date : advisor@example.com Proposal Expires : 2026-10-07 (555) 010 - 0100 Proposal Update Date: Agency: Cruise Planners - Jane Advisor MVAS Specialist: Pat Specialist Margaritaville at Sea\u00ae Group Proposal Form 420 S. Orange Ave., Suite 250, Orlando, Florida 32081 MargaritavilleAtSea.com | (800) 814 - 7100 20250 701 GENERAL TERMS, CONDITIONS, AND HELPFUL TIPS CRUISE TICKET CONTRACT Guests sailing aboard Margaritaville at Sea agree to the legally binding Cruise Ticket Contract , in addition to additional policies, such as Guest Conduct Policy , Term Of Use and our Privacy Policy . REQUIRED TRAVEL DOCUMENTATION Passengers attempting to board vessels without proper travel documentation will be denied boarding and will not be offered or eligible for a refund, replacement cruise or travel changes. For information on Identification and Travel Documents required to sail, please review our Travel Requirements & Policy . ONBOARD CHARGES For your convenience, gratuities* of $2 2 .00 per person, per night for staterooms and $2 5 .00 per person, per night for Suites (as of February 1, 2025) are automatically added to your stateroom account during your voyage. *Any gratuities and/or service fees paid by Guest are the property of the Carrier and shall be used by th e Carrier in any ma nner or method and for any purpose that the Carrier deems fit in its sole discretion. Fuel Supplements may also be added to your stateroom account based on the current fuel rates as per the Ticket Contract. As o f June 1, 2024, the Fuel Supplement is $15 per person, per night for guests sailing aboard the Margaritaville at Sea Paradise and $ 0 per person, per night for guests aboard the Margaritaville at Sea Islander . You may pre - pay any Onboard Charges by calling our Travel Specialists at (800) 814 - 7100. ARRIVAL AND EMBARKATION Find port addresses, parking rates, arrival information and more at our Arrival & Embarkation Guides . Luggage tags can be viewed and downloaded starting at 7 days before departure date from Cruise Control , Margaritaville at Sea\u2019s online guest management portal. You will need your Booking Confirmation Number and the last name of the Primary Guest listed on the reservation to log in and access your reservation. You will receive additional emails prior to your sailing date specific to your departure port with information on arrival tim es, required boarding documentation, parking and more. These emails will be received by the Primary Guest listed on the cruise rese rvation, unless emails are added for additional passengers in Cruise Control. These emails can occasionally land in Spam or O ther folders, so please search for the sender, \u201c information@cruisemvas.com .\u201d Please do not reply to these emails or send an email to this address, this sender domain is not actively monitored.";
const MVAS_3178 = "Jane Advisor Proposal ID: 3178 - 2 Sample Friends & Family Proposal Date : advisor@example.com Proposal Expires : 2026-05-05 (555) 010 - 0100 Proposal Update Date: 2026-05-06 Agency: Sample Agency Jane Advisor MVAS Specialist: Pat Specialist Margaritaville at Sea\u00ae Group Proposal Form 420 S. Orange Ave., Suite 250, Orlando, Florida 32081 MargaritavilleAtSea.com | (800) 814 - 7100 20250 701 Departure Date: 2027-01-16 Ship: Beachcomber Cabin Fare: $28,917.60 Return Date: 2027-01-23 SailingID 21328 Amenities : $4,312.00 Itinerary: 7-Night Eastern Caribbean Number of Staterooms 13 Total Amount: $33,229.60 Departure Port: Miami Total Passengers: 28 Proposal Details Price Per Guest Room Type Occupancy Type Cabins Guests Guest 1 & 2 Extra Adult Extra Child Taxes/Fees Total Fare Breezy Balcony Stateroom Double 12 24 $881.60 $181.00 $25,502.40 Breezy Balcony Stateroom Quad (All Adults) 1 4 $881.60 $464.00 $181.00 $3,415.20 Additional Amenities Qty Unit Price Total Amenities TC Credits 2 $75 Onboard Credit (GAP) Per Cabin 8 $0.00 $0.00 Gratuities (Non - Suites) Per Guest/PerNight 28 $22.00 $4,312.00 Important Dates/ Payment Terms Payment Due Date Payment Amount Countersigned Proposal 2026-05-05 $0.00 Rate Hold Deposit (Per Cabin) $50 p/Cabin ($100 for Suites) 2026-05-28 $650.00 Full Deposit $200 p/Full Fare Guest ($400 for Suites) 2026-08-19 $5,200.00 Final 2026-09-18 $27,379.60 ALL TERMS, PRICING AND AMENITIES SET FORTH IN THIS PROPOSAL EXPIRE 7 DAYS AFTER PROPOSAL DATE AND ARE SECURED WITH A HOLD DEPOSIT PAYMENT PROVIDED BY THE HOLD DUE DATE. Jane Advisor Sam Executive SVP Sales & Trade Relations Jane Advisor Proposal ID: 3178 - 2 Sample Friends & Family Proposal Date : advisor@example.com Proposal Expires : 2026-05-05 (555) 010 - 0100 Proposal Update Date: 2026-05-06 Agency: Sample Agency Jane Advisor MVAS Specialist: Pat Specialist Margaritaville at Sea\u00ae Group Proposal Form 420 S. Orange Ave., Suite 250, Orlando, Florida 32081 MargaritavilleAtSea.com | (800) 814 - 7100 20250 701 GROUP BOOKING TERMS AND CONDITIONS GROUP HOLDS AND DEPOSITS Payment of reservation HOLD amount by the Hold date secures the above committed pricing. For Standard Staterooms, required Hold amount is $50 per stateroom, due 30 days after proposal issue date. For Grand Terrace Suites, Grand Terrace Corner Suites (Islander) or Signature Grand Suites (Islander), Hold amount is $100 pe r suite. CANCELLATION POLICY Cancelled reservations due to nonpayment of balance remaining will result in cabins released into general inventory and subje ct to Cancellation Fees per our Cancellation Policy . Cruise reservations or bookings that are cancelled by the Guest prior to the first day of the Cruise are subject to a cancell ation fee except as otherwise provided in the Cancellation Policy or as otherwise provided or by applicable by law. Cancellation ch arges are subject to change without notice. 2 - 3 NIGHT SAILINGS 4 - 5 NIGHT SAILINGS Schedule Amount Schedule Amount 75 \u2013 61 Days Before Sailing 50% of Full Deposit or 50% of Fare* 90 \u2013 61 Days Before Sailing 50% of Full Deposit or 50% of Fare* 60 \u2013 31 Days Before Sailing 75% of Full Deposit or 50% of Fare* 60 \u2013 31 Days Before Sailing 75% of Full Deposit or 50% of Fare* < 30 Days Before Sailing 100% of Full Deposit or 50% of Fare* < 30 Days Before Sailing 100% of Full Deposit or 50% of Fare* 6 - 7 NIGHT SAILINGS 8+ NIGHT SAILINGS Schedule Amount Schedule Amount 120 \u2013 61 Days Before Sailing 50% of Full Deposit or 50% of Fare* 120 \u2013 61 Days Before Sailing 50% of Full Deposit or 50% of Fare* 60 \u2013 31 Days Before Sailing 75% of Full Deposit or 50% of Fare* 60 \u2013 31 Days Before Sailing 75% of Full Deposit or 50% of Fare* < 30 Days Before Sailing 100% of Full Deposit or 50% of Fare* < 30 Days Before Sailing 100% of Full Deposit or 50% of Fare* GROUP INVENTORY REVIEW PROCESS Margaritaville at Sea may contact you at any time to review the status of any unsold inventory. During this review, unsold in ventory without attached legal names and secured by full deposit may be recalled. Margaritaville at Sea reserves the right to immed iately recall any unsold inventory if the sailing is at risk of being oversold. Groups reserved on dates that are not deemed at risk of oversold capacity may have up to seven (7) days to provide legal names and full deposit payments prior to being reclaime d into general inventory. Jane Advisor Proposal ID: 3178 - 2 Sample Friends & Family Proposal Date : advisor@example.com Proposal Expires : 2026-05-05 (555) 010 - 0100 Proposal Update Date: 2026-05-06 Agency: Sample Agency Jane Advisor MVAS Specialist: Pat Specialist Margaritaville at Sea\u00ae Group Proposal Form 420 S. Orange Ave., Suite 250, Orlando, Florida 32081 MargaritavilleAtSea.com | (800) 814 - 7100 20250 701 GENERAL TERMS, CONDITIONS, AND HELPFUL TIPS CRUISE TICKET CONTRACT Guests sailing aboard Margaritaville at Sea agree to the legally binding Cruise Ticket Contract , in addition to additional policies, such as Guest Conduct Policy , Term Of Use and our Privacy Policy . REQUIRED TRAVEL DOCUMENTATION Passengers attempting to board vessels without proper travel documentation will be denied boarding and will not be offered or eligible for a refund, replacement cruise or travel changes. For information on Identification and Travel Documents required to sail, please review our Travel Requirements & Policy . ONBOARD CHARGES For your convenience, gratuities* of $2 2 .00 per person, per night for staterooms and $2 5 .00 per person, per night for Suites (as of February 1, 2025) are automatically added to your stateroom account during your voyage. *Any gratuities and/or service fees paid by Guest are the property of the Carrier and shall be used by th e Carrier in any ma nner or method and for any purpose that the Carrier deems fit in its sole discretion. Fuel Supplements may also be added to your stateroom account based on the current fuel rates as per the Ticket Contract. As o f June 1, 2024, the Fuel Supplement is $15 per person, per night for guests sailing aboard the Margaritaville at Sea Paradise and $ 0 per person, per night for guests aboard the Margaritaville at Sea Islander . You may pre - pay any Onboard Charges by calling our Travel Specialists at (800) 814 - 7100. ARRIVAL AND EMBARKATION Find port addresses, parking rates, arrival information and more at our Arrival & Embarkation Guides . Luggage tags can be viewed and downloaded starting at 7 days before departure date from Cruise Control , Margaritaville at Sea\u2019s online guest management portal. You will need your Booking Confirmation Number and the last name of the Primary Guest listed on the reservation to log in and access your reservation. You will receive additional emails prior to your sailing date specific to your departure port with information on arrival tim es, required boarding documentation, parking and more. These emails will be received by the Primary Guest listed on the cruise rese rvation, unless emails are added for additional passengers in Cruise Control. These emails can occasionally land in Spam or O ther folders, so please search for the sender, \u201c information@cruisemvas.com .\u201d Please do not reply to these emails or send an email to this address, this sender domain is not actively monitored.";

// What a different cruise line might print. Invented, and labelled as such.
const RCL_LIKE = 'Royal Caribbean International Group Proposal Prepared for: Sample Travel '
  + 'Group Name: Sample Reunion Group Group Number: 4589123 Ship: Symphony of the Seas '
  + 'Sail Date: 03/14/2027 Return Date: 03/21/2027 Itinerary: 7 Night Eastern Caribbean '
  + 'Departure Port: Port Canaveral, Florida Number of Staterooms: 10 Total Guests: 22 '
  + 'Option Date: 10/01/2026 Proposal Expires: 09/20/2026 Terms and conditions apply.';
const CARNIVAL_LIKE = 'CARNIVAL CRUISE LINE Group Quote Contract #: GQ-77821 Group Name: Sample Wedding Party '
  + 'Departure Date: March 14, 2027 Return Date: March 21, 2027 Embarkation Port: Galveston, TX '
  + 'Cabins Blocked: 8 Total Guests: 16 Cut-off Date: November 2, 2026';
const NCL_LIKE = 'Norwegian Cruise Line Group Agreement Group Name: Sample Golf Trip Ship: Norwegian Breakaway '
  + 'Sail Date: Fri, 22 Oct 2027 Return Date: 29 Oct 2027 Itinerary: 7-Day Bahamas and Florida '
  + 'Number of Staterooms: 6 Total Passengers: 12';
const BROCHURE = 'HOT Deals of the Week 09/21/26 Featured Supplier of the Week: Royal Caribbean International '
  + 'Signature Exclusive - Receive a Specialty Dining Experience for Two on select sailings: '
  + 'Booking Window: September 1 - 31 2026 Terms and conditions apply to all offers shown.';

console.log('\nThe group proposal readers');

// ------------------------------------------------ the real proposals ----
{
  const r = parseGroupQuote(MVAS_4589);
  is('a real Margaritaville proposal is read by the exact reader',
    [r.read, r.format && r.format.id, r.format && r.format.exact], [true, 'mvas', true]);
  is('the group, ship and itinerary',
    [r.fields.name, r.fields.productName, r.fields.destination],
    ['Sample Group (10/22/2027)', 'Beachcomber', '7-Night Belize & Mexico']);
  is('both dates, and the rate hold as the option date',
    [r.fields.departDate, r.fields.returnDate, r.fields.optionDate],
    ['2027-10-22', '2027-10-29', '2026-10-30']);
  is('cabins and passengers', [r.fields.cabinsHeld, r.fields.passengers], [9, 18]);
  is('the two references and who to ring',
    [r.fields.proposalId, r.fields.sailingId, r.fields.vendorContact],
    ['4589', '22198', 'Pat Specialist']);
  is('the port and when the proposal lapses',
    [r.fields.departurePort, r.fields.proposalExpires], ['Galveston', '2026-10-07']);
  is('the group number is left empty, because the form never carries one',
    [r.fields.groupCode, r.noGroupNumber, r.missing.includes('groupCode')], ['', true, false]);
  is('four grades', r.rates.length, 4);
  is('and every one adds up to the total printed beside it',
    r.rates.every((x) => x.reconciles), true);
  is('the first grade, in cents',
    [r.rates[0].roomType, r.rates[0].perGuestCents, r.rates[0].taxesCents, r.rates[0].totalCents],
    ['Cozy Interiors', 35898, 18300, 216792]);
  is('the payment terms ride in the notes', /Rate Hold Deposit[^]*\$500\.00 due 2026-10-30/.test(r.notes), true);
}
{
  const r = parseGroupQuote(MVAS_3178);
  is('a second proposal, from different software, is read the same way',
    [r.read, r.format && r.format.id], [true, 'mvas']);
  is('a revision after the number is part of the number, not the start of the name',
    [r.fields.proposalId, r.fields.name], ['3178-2', 'Sample Friends & Family']);
  is('both grades are found, where one used to be',
    r.rates.map((x) => [x.occupancy, x.cabins, x.guests]),
    [['Double', 12, 24], ['Quad (All Adults)', 1, 4]]);
  is('the quad cabin carries its extra adult rate',
    [r.rates[1].perGuestCents, r.rates[1].extraAdultCents, r.rates[1].extraChildCents],
    [88160, 46400, 0]);
  is('and both still add up', r.rates.every((x) => x.reconciles), true);
  is('when it was last updated is kept', /Updated 2026-05-06/.test(r.notes), true);
  is('dates and counts', [r.fields.departDate, r.fields.optionDate, r.fields.cabinsHeld, r.fields.passengers],
    ['2027-01-16', '2026-05-28', 13, 28]);
}

// A row that does not add up must say so rather than be saved as right.
{
  const good = cabinRows('Total Fare Breezy Balcony Double 2 4 $100.00 $50.00 $600.00 Additional Amenities');
  const wrong = cabinRows('Total Fare Breezy Balcony Double 2 4 $100.00 $50.00 $999.00 Additional Amenities');
  is('a grade whose figures add up is marked as adding up', good[0] && good[0].reconciles, true);
  is('and one that does not is marked as not', wrong[0] && wrong[0].reconciles, false);
}

// ---------------------------------------------- the tidying, on its own ---
is('a kerned date is one date', tidy('Sails 2027 - 10 - 22 from Miami'), 'Sails 2027-10-22 from Miami');
is('and a split capital is one word', tidy('A menities : $2,814.00'), 'Amenities : $2,814.00');
is('language tags are not words', tidy('Ship: en-US Beachcomber en-US'), 'Ship: Beachcomber');

// ----------------------------------------------------------- the dates ---
is('an ISO date', parseDate('2027-10-22'), '2027-10-22');
is('an American date is read month first', parseDate('10/11/2027'), '2027-10-11');
is('a first number above twelve can only be a day', parseDate('22/10/2027'), '2027-10-22');
is('a written month, in either order', [parseDate('Oct 22, 2027'), parseDate('22 October 2027')], ['2027-10-22', '2027-10-22']);
is('a date that does not exist is not a date', parseDate('02/30/2027'), '');
is('a two digit year is refused rather than guessed', parseDate('10/22/27'), '');

// ------------------------------------- a layout nobody has written for ---
{
  const r = parseGroupQuote(RCL_LIKE);
  is('an unfamiliar layout is read by the fallback, and says so',
    [r.read, r.format.id, r.format.exact], [true, 'generic', false]);
  is('the cruise line comes from the letterhead', r.fields.vendor, 'Royal Caribbean');
  is('what a label says is taken on its word',
    [r.fields.name, r.fields.productName, r.fields.departDate, r.fields.returnDate],
    ['Sample Reunion Group', 'Symphony of the Seas', '2027-03-14', '2027-03-21']);
  is('a group whose name ends in a label\'s first word still ends where it should',
    [r.fields.name, r.fields.groupCode], ['Sample Reunion Group', '4589123']);
  is('the rest',
    [r.fields.destination, r.fields.departurePort, r.fields.cabinsHeld, r.fields.passengers,
      r.fields.optionDate, r.fields.proposalExpires],
    ['7 Night Eastern Caribbean', 'Port Canaveral, Florida', 10, 22, '2026-10-01', '2026-09-20']);
  is('no rate grid is invented', [r.rates.length, r.notes], [0, '']);
  is('and a group number that was not in the document is reported as missing',
    parseGroupQuote(CARNIVAL_LIKE).missing.includes('groupCode'), true);
}
{
  const r = parseGroupQuote(CARNIVAL_LIKE);
  is('a proposal number is never taken for a group number',
    [r.fields.proposalId, r.fields.groupCode], ['GQ-77821', '']);
  is('the line is named even in capitals', r.fields.vendor, 'Carnival Cruise Line');
  is('dates written out in words', [r.fields.departDate, r.fields.returnDate, r.fields.optionDate],
    ['2027-03-14', '2027-03-21', '2026-11-02']);
  is('a port with a state after it', r.fields.departurePort, 'Galveston, TX');
}
{
  const r = parseGroupQuote(NCL_LIKE);
  is('a weekday before the date does not stop it being read',
    [r.fields.departDate, r.fields.returnDate], ['2027-10-22', '2027-10-29']);
  is('and the ship', r.fields.productName, 'Norwegian Breakaway');
}

// ----------------------------------------------------- and the refusals ---
is('a brochure is not a group quote, however many dates are in it',
  parseGroupQuote(BROCHURE).read, false);
is('nothing at all is not one either', parseGroupQuote('').read, false);
is('nor a few words', parseGroupQuote('Sail Date: 10/22/2027').read, false);
is('a group number that is still to come is not a group number',
  parseGroupQuote(RCL_LIKE.replace('Group Number: 4589123', 'Group Number: Pending')).fields.groupCode, '');
is('a two digit year is left for a person',
  parseGroupQuote(RCL_LIKE.replace('03/14/2027', '03/14/27')).fields.departDate, '');
is('and a Margaritaville proposal is never handed to the fallback',
  FORMATS.some((f) => f.matches(tidy(MVAS_4589))), true);

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) { console.log(`${failures} failed`); process.exit(1); }
