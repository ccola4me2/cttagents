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
import { parseDate, titleCase, lastFirst } from '../src/groupquote-util.js';
import { md5, rc4, openEncryption } from '../src/pdfcrypt.js';
import { decodeContent, isPlainText } from '../src/pdftext.js';

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

// Real contracts, with the people in them replaced. Norwegian's prints every value
// before its label, and Celebrity's was locked against copying; both are here as the
// text the PDF reader produced once it had opened them.
const NCL_FS = "FS GROUP AGREEMENT Norwegian Cruise Line www.ncl.com 800-327-7030 Booking Date: September 16, 2026 September 29, 2026Issue Date: Page 1 of 2 AGENCY ==> 100001 SAMPLE AGENCY, LLC 1 MAIN ST Anytown, FL 33000 US Norwegian Escape Sample Wedding PAT MANAGER 5550100100 FS GROUP ==> A1234567 USD Ship: Sail Date: FS Group Name: Sales Manager: Currency: July 2, 2027 All cabin rates are per person based on double occupancy; single, triple and quad cabins are on a request basis. All air add-ons, package rates and add-on rates are per person. Government taxes and fees are subject to change. Please review the Group Terms and Conditions for additional information. FS Group Cabin Space Total Fare per Guest Pricing Category Fare per Guest Comm % GTFPE*Number of Cabins Berthing Category Cabin Type Balcony BC BC 20 738.65 10.0 220.00 958.65 Inside IB IB 10 526.15 10.0 220.00 746.15 Club Balcony MB MB 5 798.15 10.0 220.00 1,018.15 *NCF = Non-Commissionable Fare; GTFPE = Government Taxes, Fees & Port Expenses; includes GET Tax & Hawaii State and County Tax Payment Schedule 1,750.00FIRST DEPOSIT due on 11/15/2026 61,700.50FINAL PAYMENT due on 05/03/2027 Please note that amount stated for Final Payment can vary and depend on actual bookings at time of group finalization. Amenity Value GAP050 Cabin assignments with names require full deposit within 7 days. Cabin assignments without names require immediate deposit. Child traveling as 2nd guest in cabin pays adult fare. 3 to 8 guest prices are subject to change upon availability. Confirmation Remarks TC Ratio: 1:16 FS GROUP AGREEMENT Norwegian Cruise Line www.ncl.com 800-327-7030 Booking Date: September 16, 2026 September 29, 2026Issue Date: Page 2 of 2 AGENCY ==> 100001 SAMPLE AGENCY, LLC 1 MAIN ST Anytown, FL 33000 US Norwegian Escape Sample Wedding PAT MANAGER 5550100100 FS GROUP ==> A1234567 USD Ship: Sail Date: FS Group Name: Sales Manager: Currency: July 2, 2027 *********************************************** I m p o r t a n t R e m i n d e r *********************************************** As visa and documentation requirements vary by country and are subject to change, all guests are urged to contact their travel professional, local immigration office, or the embassy or consulate for each country they will visit on their cruise to verify current entry requirements. It is the guest's responsibility to obtain required visas and other documentation prior to sailing, including vaccinations for infectious diseases. Additional information for booked guests is available on www.ncl.com . Online Check-In: We highly recommend guests to complete their online check-in form at www.ncl.com at least 21 days and no less than 3 days prior to the vacation start date. Guests who complete the online check-in will still need to check-in with our port agents to complete the boarding process. Guests who do not complete their online check-in will be required to complete the entire check-in process at the pier, at least 2 hours prior to the departure time noted on their cruise documents. TSA Requirements: TSA requirements mandate that for all guests who have purchased air, NCL must provide TSA with Full Names (as it appears on your passport) that includes middle name if applicable, Date of Birth and Gender. Without this information you can be denied boarding the aircraft. Domestic Airline Travel ID Requirements for U.S. Citizens: Beginning May 7, 2025, every air traveler 18 years of age and older will need a REAL ID-compliant driver's license, state-issued enhanced driver's license, or another acceptable form of ID to fly within the United States. REAL IDs are marked by a star on the top of the card. Between now and the effective date of the new regulations, we encourage all travelers to check their IDs and obtain a REAL ID if they don't already have one. To obtain a REAL ID requires documentation beyond what is required for most standard drivers' licenses. Prepare to collect and present several documents to DMV officials that prove residency and identification. Guests should take this into consideration when planning travels for their cruise. To find out if your state is in compliance, please click here . To learn more about REAL ID, please click here . For more information, including other acceptable forms of identification, please click here . **************************************** F i n a l B o a r d i n g T i m e P o l i c y **************************************** Please be advised that on Embarkation Day, all guests must be onboard the ship no less than two hours from the ship's scheduled departure time. Please go to www.ncl.com for additional information. Cruise Itinerary Depart Time Arrive Time Date Port of Call ORLANDO-BEACHES-PORT CANAVERAL 07/02/2027 4:00 pm AT SEA 07/03/2027 COZUMEL 07/04/2027 8:00 am 4:00 pm AT SEA 07/05/2027 GREAT STIRRUP CAY 07/06/2027 7:00 am 5:00 pm ORLANDO-BEACHES-PORT CANAVERAL 07/07/2027 7:00 am";
const CELEBRITY = "Group Quote Introduction Group ID: 1234567 Group Name: SAMPLE BIRTHDAY BASH CELEBRITY REFLECTION Sail Date: 19 MAR 2027 Welcome to Celebrity Cruises! Thank you for choosing to book your group with Celebrity Cruises , we truly appreciate your business. Your boo ... Group Quote Summary Attn: Jane Advisor Group ID: 1234567 Issue Date: 30 SEP 2026 SAMPLE AGENCY LLC Group Name: SAMPLE BIRTHDAY BASH Partner Advocate: 1 MAIN ST Ship: CELEBRITY REFLECTION Extension: ANYTOWN, FL, 33000 Sailing Date: 19 MAR 2027 Email Address: UNITED STATES Itinerary: 3 NIGHT KEY WEST & BAHAMAS CRUISE Rep: SAMPLE,PAT Cruise Itinerary Date Port Location Arrive Depart 19 MAR 20 MAR 21 MAR 22 MAR FORT LAUDERDALE, FLORIDA KEY WEST, FLORIDA GRAND BAHAMA ISL, BAHAMAS FORT LAUDERDALE, FLORIDA 8:00 AM 8:00 AM 7:00 AM 4:00 PM 5:00 PM 5:00 PM Please note itineraries may change as conditions warrant. Group Policy No-Deposit Payment Schedule ( Currency: USD) Due Date(s) Deposit Required Cumulative Deposit Due 29 OCT 2026 3200.00 3200.00 North American bookings will require a 200% deposit of standard deposit amount for deluxe suite categories. This amount is not reflected in the total deposit requirement listed above. Please adjust the amount due accordingly based upon the suite category allotment in the group. Final payment due: 03 JAN 2027 \u00b7 Celebrity Cruises may contact you at anytime to review your group inventory. During this review, unsold space (stateroom inventory without names and full deposit) may be recalled. \u00b7 Celebrity Cruises reserves the right to contact you at anytime to review group inventory held on specific sail dates that are at risk of being oversold. During this review, all unsold space (stateroom inventory without names and full deposit) will be recalled. \u00b7 Full Names and deposits are due as option dates are reached. Space without names and deposit cross-referenced on or before the due date may be released. \u00b7 \u00b7 \u00b7 \u00b7 \u00b7 Celebrity Cruises reserves the right to impose a fuel supplement on all guests if the price of West Texas Intermediate fuel exceeds $65.00 per barrel. The fuel supplement for 1st and 2nd guests would be no more than $10 per guest per day, to a maximum of $140 per cruise; and for additional guests would be no more than $5 per person per day, to a maximum of $70 per cruise. Cancellation Schedule Days Prior to Sailing Cancellation Schedule Date 74 to 61 60 to 31 50% per Guest 75% per Guest 04 JAN 2027 18 JAN 2027 Sailing operated by Celebrity Cruises Inc. 1050 Caribbean Way, Miami, Florida 33132 2 of 7 Wednesday, September 30, 2026 Group Quote Summary Attn: Jane Advisor Group ID: 1234567 Issue Date: 30 SEP 2026 SAMPLE AGENCY LLC Group Name: SAMPLE BIRTHDAY BASH Partner Advocate: 1 MAIN ST Ship: CELEBRITY REFLECTION Extension: ANYTOWN, FL, 33000 Sailing Date: 19 MAR 2027 Email Address: UNITED STATES Itinerary: 3 NIGHT KEY WEST & BAHAMAS CRUISE Rep: SAMPLE,PAT 30 to 0 100% per Guest 17 FEB 2027 Sailing operated by Celebrity Cruises Inc. 1050 Caribbean Way, Miami, Florida 33132 3 of 7 Wednesday, September 30, 2026 Group Quote Other Charges Detail Group ID: 1234567 Group Name: SAMPLE BIRTHDAY BASH CELEBRITY REFLECTION Sail Date: 19 MAR 2027 Group Level Activities Title Description Quantity Unit Charge Commission Rate Total Guest Level Activities Guest Name Res ID Title Description Quantity Unit Charge Commission Rate Total Sailing operated by Celebrity Cruises Inc. 1050 Caribbean Way, Miami, Florida 33132 4 of 7 Wednesday, September 30, 2026 Group Quote Inventory Group ID: 1234567 Group Name: SAMPLE BIRTHDAY BASH CELEBRITY REFLECTION Sail Date: 19 MAR 2027 Stateroom Inventory Category Occupancy Guarantees Allocated Price Commissionable Fare per Guest Commission Rate Non-Commissionable Cruise Fare Per Guest Named Unnamed Named Unnamed Guest 1 & 2 Guest 3 & 4 A2 C4 I1 Double Double Double 0 0 0 0 0 0 0 0 0 0 0 0 1 10 5 16 GROUPX GROUPX GROUPX 879.00 683.00 561.00 879.00 683.00 561.00 0.00 0.00 0.00 0.00 0.00 0.00 10% 10% 10% 90.00 90.00 90.00 Dining Confirmed Waitlist CEL SLCT 6:00 PM * 6:00 PM A2 10 20 2 0 0 0 Complimentary Berths (Tour conductor credits) Earned Ratio: 1 for 16 Limits: Cruise = 999 Category Price Promo Type # of Comp. Berths Fare per Berth Total Comp. Value N/A 2 -657.12 -1314.24 Allocated Staterooms Category Staterooms A2(Double) C4(Double) I1(Double) 1550 9107 , 9109 , 9122 , 9123 , 9126 , 9131 , 9135 , 9136 , 9364 , 9370 1592 , 1594 , 1600 , 1604 , 1608 Air Inventory: Gateways Gateway Confirmed Waitlist Air and C/O Inventory: Air Add-On Fares and Taxes & Fees Price Program Gateway 1st/2nd (P/P) 3rd/4th (P/P) Taxes & Fees (P/P) Other Air Fees (P/P) GROUPX C/O 166.22 Sailing operated by Celebrity Cruises Inc. 1050 Caribbean Way, Miami, Florida 33132 5 of 7 Wednesday, September 30, 2026 Group Quote Inventory Group ID: 1234567 Group Name: SAMPLE BIRTHDAY BASH CELEBRITY REFLECTION Sail Date: 19 MAR 2027 The Department of Homeland Security requires all Domestic US Airlines to collect the following information for each passenger; Passengers Full Nam";
// A locked file built by an independent implementation, so the reader has to derive
// the same keys to open it.
const LOCKED = "%PDF-1.4\n1 0 obj\n<< /Filter /Standard /V 1 /R 2 /P -44 /O <0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20> /U <b8c6558d49b61aa73becc772ceebba1a71a52c842214bb9db38f8aaca3ca3430> >>\nendobj\ntrailer\n<< /Encrypt 1 0 R /ID [<6465666768696a6b6c6d6e6f70717273> <6465666768696a6b6c6d6e6f70717273>] >>\n";
const LOCKED_CIPHER = [148, 116, 43, 67, 231, 128, 197, 19, 247, 192, 3, 233, 110, 233, 136, 182, 5, 80, 216, 254, 64, 224, 99, 65, 104, 49, 66, 150, 115, 19];
const LOCKED_PLAIN = "BT /F1 12 Tf (Sail Date) Tj ET";

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

// -------------------------------------------- Norwegian, a real contract ---
{
  const r = parseGroupQuote(NCL_FS);
  is('a Norwegian FS group agreement is read by its own reader',
    [r.read, r.format && r.format.id, r.format && r.format.exact], [true, 'ncl-fs', true]);
  is('values drawn before their labels are still found',
    [r.fields.name, r.fields.productName, r.fields.groupCode],
    ['Sample Wedding', 'Norwegian Escape', 'A1234567']);
  is('this layout carries a group number, so it is filled in and is not called missing',
    [r.fields.groupCode !== '', r.noGroupNumber, r.missing.includes('groupCode')], [true, false, false]);
  is('the dates, from the header and the last port of call',
    [r.fields.departDate, r.fields.returnDate], ['2027-07-02', '2027-07-07']);
  is('the itinerary is worked out from the ports, without the days at sea',
    [r.fields.destination, r.fields.departurePort],
    ['5-Night Cozumel & Great Stirrup Cay', 'Orlando-Beaches-Port Canaveral']);
  is('the cruise line\'s sales manager', r.fields.vendorContact, 'Pat Manager');
  is('three categories, in cents, per guest and for the row',
    r.rates.map((x) => [x.roomType, x.cabins, x.guests, x.perGuestCents, x.taxesCents, x.totalCents]),
    [['Balcony (BC)', 20, 40, 73865, 22000, 3834600],
      ['Inside (IB)', 10, 20, 52615, 22000, 1492300],
      ['Club Balcony (MB)', 5, 10, 79815, 22000, 1018150]]);
  is('and each adds up to its printed total', r.rates.every((x) => x.reconciles), true);
  is('35 cabins, and 70 guests because the payments confirm two to a cabin',
    [r.fields.cabinsHeld, r.fields.passengers, r.warnings], [35, 70, []]);
  is('the payment schedule is in the notes, amount before label and all',
    /First Deposit: \$1,750\.00 due 2026-11-15[^]*Final Payment: \$61,700\.50 due 2027-05-03/.test(r.notes), true);
  // The same contract with its final payment changed must no longer claim 70 guests.
  const off = parseGroupQuote(NCL_FS.replace('61,700.50FINAL', '51,700.50FINAL'));
  is('payments that do not match the rates are flagged, and the guest count is withheld',
    [off.warnings.length, off.fields.passengers], [1, 0]);
  is('no option date is invented where the contract has none',
    [r.fields.optionDate, r.missing.includes('optionDate')], ['', true]);
}

// -------------------------------------------- Celebrity, a real contract ---
{
  const r = parseGroupQuote(CELEBRITY);
  is('a Celebrity group quote is read by its own reader',
    [r.read, r.format && r.format.id, r.format && r.format.exact], [true, 'celebrity-group-quote', true]);
  is('the group name is the summary\'s, not the letter\'s with the ship stuck on the end',
    [r.fields.name, r.fields.groupCode], ['SAMPLE BIRTHDAY BASH', '1234567']);
  is('ship and itinerary are title-cased; the rep\'s name is put the right way round',
    [r.fields.productName, r.fields.destination, r.fields.vendorContact],
    ['Celebrity Reflection', '3 Night Key West & Bahamas Cruise', 'Pat Sample']);
  is('the return date comes from a column of dates with no year',
    [r.fields.departDate, r.fields.returnDate], ['2027-03-19', '2027-03-22']);
  is('the port is the first of the ports of call', r.fields.departurePort, 'Fort Lauderdale, Florida');
  is('the first deposit date is the option date, as the quote itself says', r.fields.optionDate, '2026-10-29');
  is('sixteen cabins, counted from the allocated rooms', r.fields.cabinsHeld, 16);
  is('guests are not stated, so they are not guessed', [r.fields.passengers, r.missing.includes('passengers')], [0, true]);
  is('a category is the room type: one grid row for each, counted from the allocated rooms',
    r.rates.map((x) => [x.roomType, x.occupancy, x.cabins, x.guests, x.perGuestCents, x.totalCents]),
    [['A2', 'Double', 1, 2, 87900, 175800], ['C4', 'Double', 10, 20, 68300, 1366000],
     ['I1', 'Double', 5, 10, 56100, 561000]]);
  is('the rows add up to the cabins held', r.rates.reduce((n, x) => n + x.cabins, 0), r.fields.cabinsHeld);
  is('the fares are not repeated in the notes once they are in the grid', /Category A2/.test(r.notes), false);
  const odd = parseGroupQuote(CELEBRITY.replace('1 10 5 16 GROUPX', '2 9 5 16 GROUPX'));
  is('a category count that disagrees with the allocated column leaves the grid empty, fares in the notes',
    [odd.rates.length, /Category A2: \$879\.00[^]*Category C4: \$683\.00[^]*Category I1: \$561\.00/.test(odd.notes)], [0, true]);
  is('cancellation charges come with their dates, which agree with the day counts',
    /50% per guest from 2027-01-04 \(74 to 61[^]*75% per guest from 2027-01-18[^]*100% per guest from 2027-02-17/.test(r.notes), true);
  is('deposit and final payment', /Deposit: \$3,200\.00 due 2026-10-29[^]*Final payment due 2027-01-03/.test(r.notes), true);
}

// The two must never be mistaken for one another, or for the fallback.
is('each layout claims only its own contract',
  [[MVAS_4589, NCL_FS, CELEBRITY].map((x) => FORMATS.filter((f) => f.matches(tidy(x))).map((f) => f.id))],
  [[['mvas'], ['ncl-fs'], ['celebrity-group-quote']]]);

// -------------------------------------------------------- text helpers ---
is('a shouted place is title-cased', titleCase('GRAND BAHAMA ISL'), 'Grand Bahama Isl');
is('small words stay small, and hyphens start a new word',
  [titleCase('ICON OF THE SEAS'), titleCase('ORLANDO-BEACHES-PORT CANAVERAL')],
  ['Icon of the Seas', 'Orlando-Beaches-Port Canaveral']);
is('text somebody wrote is left exactly as it was', titleCase('Norwegian Escape'), 'Norwegian Escape');
is('a name printed surname first', lastFirst('LANDERS-TAYLOR,ROBERT'), 'Robert Landers-Taylor');

// ------------------------------------------------ a file that is locked ---
{
  const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
  const enc = (t) => Uint8Array.from(t, (c) => c.charCodeAt(0));
  is('MD5 and RC4 give the published answers',
    [hex(md5(enc('abc'))), hex(rc4(Uint8Array.from([1, 2, 3, 4, 5]), new Uint8Array(4)))],
    ['900150983cd24fb0d6963f7d28e17f72', 'b2396305']);

  const lock = openEncryption(LOCKED);
  is('a file locked without a password is opened with the empty one', lock.kind, 'rc4');
  is('and its streams are unscrambled with a key of their own',
    lock.decrypt && String.fromCharCode(...lock.decrypt(Uint8Array.from(LOCKED_CIPHER), 7, 0)), LOCKED_PLAIN);
  is('the same bytes as another object come out as nonsense, so the keys really are per object',
    lock.decrypt && String.fromCharCode(...lock.decrypt(Uint8Array.from(LOCKED_CIPHER), 8, 0)) === LOCKED_PLAIN, false);
  is('a file whose password check fails is reported as needing one, not read as blanks',
    openEncryption(LOCKED.replace(/\/U <(..)/, (m, a) => `/U <${a === 'ff' ? '00' : 'ff'}`)).kind, 'password');
  is('a newer kind of lock is reported as unsupported, not half decoded',
    openEncryption(LOCKED.replace('/V 1 /R 2', '/V 4 /R 4 /CF << /StdCF << /CFM /AESV2 >> >>')).kind, 'unsupported');
  is('an ordinary file is not treated as locked', openEncryption('%PDF-1.4 1 0 obj << >> endobj').kind, 'none');
}

// ----------------------------------------------- how the text is drawn ---
{
  const map = new Map([[0x26, 'S'], [0x44, 'a'], [0x4c, 'i'], [0x4f, 'l'], [0x03, ' ']]);
  const said = (stream) => decodeContent(stream, map).replace(/\s+/g, ' ').trim();
  // Chrome writes every glyph as its own move with no vertical change.
  is('a line drawn one glyph at a time is one line, not one letter per line',
    said('BT /F4 18 Tf 1 0 0 -1 0 19 Tm <0026> Tj 10 0 Td <0044> Tj 9 0 Td <004C> Tj 5 0 Td <004F> Tj ET'), 'Sail');
  is('a move down is a new line', said('BT /F1 12 Tf 1 0 0 1 0 0 Tm <0026> Tj 0 -14 Td <0044> Tj ET'), 'S a');
  is('a big sideways jump is a column gap', said('BT /F1 12 Tf <0026> Tj 200 0 Td <0044> Tj ET'), 'S a');
  is('a large backward kern in a TJ array is a space and a small one is not',
    [said('BT [(Sail) -250 (Date)] TJ ET'), said('BT [(Sa) -20 (il)] TJ ET')], ['Sail Date', 'Sail']);
  is('a language tag is not text', said('/Span <</Lang (en-US)>> BDC BT (Ship) Tj ET EMC'), 'Ship');
  is('octal escapes in a string are read', said('BT (A\\050B\\051) Tj ET'), 'A(B)');
  is('uncompressed page content is recognised, binary data is not',
    [isPlainText(Uint8Array.from('q 612 0 0 792 0 0 cm BT /F0 12 Tf (Hello there) Tj ET', (c) => c.charCodeAt(0))),
      isPlainText(Uint8Array.from({ length: 400 }, (_, i) => (i * 37 + 11) % 256))],
    [true, false]);
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
