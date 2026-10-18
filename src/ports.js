// Where a sailing leaves from, in words.
//
// A cruise line's paperwork says TPA and MIA, which is the airport code and means nothing to the
// people reading a group's page. A value that is exactly one of these codes is written out as the
// city; anything else, including a port already typed in full, is left exactly as it was.

const PORTS = {
  TPA: 'Tampa', MIA: 'Miami', FLL: 'Fort Lauderdale', PEF: 'Fort Lauderdale', PEV: 'Fort Lauderdale',
  PCF: 'Port Canaveral', CNV: 'Port Canaveral', MCO: 'Port Canaveral', CPV: 'Port Canaveral',
  JAX: 'Jacksonville', GLS: 'Galveston', GAL: 'Galveston', HOU: 'Galveston', NOL: 'New Orleans', MSY: 'New Orleans',
  MOB: 'Mobile', CHS: 'Charleston', SAV: 'Savannah', NYC: 'New York', BAY: 'Bayonne', EWR: 'Cape Liberty',
  BOS: 'Boston', BWI: 'Baltimore', BAL: 'Baltimore', ORF: 'Norfolk', NFK: 'Norfolk', PHL: 'Philadelphia',
  LAX: 'Los Angeles', LGB: 'Long Beach', SAN: 'San Diego', SFO: 'San Francisco', SEA: 'Seattle',
  VAN: 'Vancouver', YVR: 'Vancouver', ANC: 'Anchorage', SEW: 'Seward', WHT: 'Whittier', HNL: 'Honolulu',
  SJU: 'San Juan', NAS: 'Nassau', BGI: 'Barbados', CZM: 'Cozumel', GCM: 'Grand Cayman',
  BCN: 'Barcelona', CIV: 'Civitavecchia', FCO: 'Rome', VCE: 'Venice', SOU: 'Southampton', LHR: 'Southampton',
  AMS: 'Amsterdam', CPH: 'Copenhagen', REK: 'Reykjavik', SYD: 'Sydney', AKL: 'Auckland',
};

/** The city for a port or airport code, or the value untouched when it is not one we know. */
export function portName(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return /^[A-Za-z]{3}$/.test(text) && PORTS[text.toUpperCase()] ? PORTS[text.toUpperCase()] : text;
}
