// Shared sample fleet for the v2 staging pages.
//
// Extracted so the Dispatch Board and Reports cannot drift apart: both pages
// describe the same 45 trucks, so a reviewer comparing them sees one fleet
// rather than two invented ones that disagree.
//
// b/ty/s are DAYS ELAPSED since the last brake test / tyre check / service —
// the same sense as getVehicleStatus()'s brakeDays, tyreDays, serviceDays.
// ann is days REMAINING on the annual DOT certificate (negative = expired).

// SCHED_DEFAULTS (js/app.js ~123). dot_inspection is the yard/periodic service
// clock: 90 days, per the fleet ruling that Yard Visit / Service Due is 90 days
// everywhere in the application.
const SCHED = {
  brake: { interval: 30, warn: 7 },   // brakeOverdue > 30, dueSoon > 23
  svc:   { interval: 90, warn: 7 },   // serviceOverdue > 90, dueSoon > 83
  tyre:  { interval: 7,  warn: 0 },   // tyreOverdue >= 7
};
const ANNUAL_WARN_DAYS = 30;

const T = (t, tr, d, b, ty, s, pti, ann, extra = {}) =>
  ({ t, tr, d, b, ty, s, pti, ann, ...extra });

const FLEET = {
  'Alex': [
    T('25086', '4412', 'Marcus Webb',    12, 2, 34, true,  210),
    T('25141', '4407', 'Ray Osei',        9, 3, 94, true,  180),
    T('26016', '5120', 'Dana Kroll',     14, 8, 41, true,  155),
    T('25940', '4390', 'Ivan Petrov',     6, 1, 22, true,  260),
    T('26102', '5133', 'Sam Ortiz',      18, 4, 58, false, 240),
  ],
  'Andy': [
    T('25004', '4331', 'Hector Diaz',    11, 2, 27, true,  300),
    T('25873', '4402', 'Nina Alvarez',   16, 5, 63, true,  190),
    T('26041', '5108', 'Terrence Boyd',   7, 1, 12, true,  275),
    T('25046', '4358', 'Priya Raman',    31, 9, 88, false, 120, { vac: true }),
  ],
  'Arthur': [
    T('25094', '4366', 'Luis Ferrer',    25, 3, 48, true,  165),
    T('26127', '5141', 'Owen Blake',     13, 2, 31, true,  220),
    T('25612', '4377', 'Colin Mabe',      5, 4, 19, true,  250),
    T('26057', '5115', 'Josie Hart',     19, 6, 70, false, 140),
  ],
  'Carl': [
    T('25218', '4340', 'Andre Kalu',     10, 2, 25, true,  230, { def: 'defect' }),
    T('25455', '4381', 'Bea Nowak',       8, 3, 52, true,   18),
    T('26073', '5127', 'Kofi Mensah',    15, 1, 37, true,  195),
    T('25709', '4395', 'Dmitri Volkov',  20, 5, 66, true,  205),
    T('26088', '5136', 'Talia Reyes',     4, 2,  8, true,  288),
  ],
  'Cody': [
    T('25330', '4349', 'Miguel Sosa',    12, 3, 44, true,  175),
    T('25887', '4409', 'Grace Otieno',   17, 1, 29, true,  245),
    T('26011', '5104', 'Ben Harlow',      6, 4, 15, true,  265),
    T('26140', '5148', 'Ana Cardoso',    21, 2, 61, false, 150),
  ],
  'David': [
    T('25162', '4335', 'Peter Nagy',      9, 9, 39, true,  185),
    T('25501', '4384', 'Yusuf Demir',    14, 3, 55, true,  215),
    T('25963', '4415', 'Lena Fischer',    3, 1, 11, true,  295),
    T('26030', '5111', 'Omar Haddad',    18, 5, 72, true,  160),
    T('26115', '5138', 'Ruth Kimani',    11, 2, 33, true,  235),
  ],
  'Dom': [
    T('25277', '4344', 'Victor Cruz',    13, 4, 46, true,  200),
    T('25822', '4400', 'Femi Adeyemi',    7, 2, 23, true,  255),
    T('26064', '5122', 'Iris Lindqvist', 16, 6, 68, false, 170),
    T('25389', '4353', 'Sasha Ivanova',  27, 4, 79, false, 110, { vac: true }),
  ],
  'G-SDE': [
    T('25058', '4327', 'Caleb Whit',     10, 3, 36, true,  225, { def: 'minor' }),
    T('25744', '4398', 'Noor Rahman',     5, 1, 17, true,  270),
    T('26099', '5130', 'Julio Barros',   19, 4, 59, true,  145),
    T('26152', '5152', 'Mei Tanaka',     12, 2, 42, true,  210),
  ],
  'Jacob': [
    T('25196', '4338', 'Silas Novak',     8, 3, 28, true,  280),
    T('25650', '4392', 'Aida Sow',       15, 2, 50, true,  190),
    T('26022', '5107', 'Rory Quinn',      4, 5, 14, true,  260),
    T('26134', '5145', 'Elena Rossi',    20, 1, 64, false, 135),
  ],
  'John': [
    T('25113', '4333', 'Duncan Frye',    26, 2, 43, true,  180),
    T('25573', '4387', 'Halima Yusuf',   11, 4, 57, true,  205),
    T('25901', '4411', 'Tomas Vargas',    6, 1, 20, true,  285),
    T('26048', '5118', 'Greta Lang',     17, 3, 38, true,  165),
    T('26146', '5150', 'Aaron Beck',     13, 5, 62, true,  230),
  ],
};
const UNASSIGNED = [T('25999', '4420', null, 9, 2, 30, false, 240)];

// getVehicleStatus(), the parts these pages read.
function status(v) {
  const brakeOverdue  = v.b > SCHED.brake.interval;
  const brakeDueSoon  = v.b > SCHED.brake.interval - SCHED.brake.warn && !brakeOverdue;
  const tyreOverdue   = v.ty >= SCHED.tyre.interval;
  const serviceOverdue = v.s > SCHED.svc.interval;
  const serviceDueSoon = v.s > SCHED.svc.interval - SCHED.svc.warn && !serviceOverdue;
  const annualExpired = v.ann < 0;
  const annualDueSoon = v.ann >= 0 && v.ann <= ANNUAL_WARN_DAYS;
  const defectCritical = v.def === 'defect';
  const defectMinor    = v.def === 'minor';
  // Exactly production's expression. viciousCircle is omitted: it needs the
  // maintenance/brake join this sample set does not model.
  const critical = brakeOverdue || serviceOverdue || defectCritical || annualExpired;
  const warning  = brakeDueSoon || tyreOverdue || defectMinor || annualDueSoon;
  return { brakeOverdue, brakeDueSoon, tyreOverdue, serviceOverdue, serviceDueSoon,
           annualExpired, annualDueSoon, defectCritical, defectMinor, critical, warning };
}

// Every truck with its dispatcher, assigned or not.
function allTrucks() {
  const out = [];
  for (const name of Object.keys(FLEET).sort()) FLEET[name].forEach(v => out.push({ ...v, disp: name }));
  UNASSIGNED.forEach(v => out.push({ ...v, disp: null }));
  return out;
}

module.exports = { SCHED, ANNUAL_WARN_DAYS, FLEET, UNASSIGNED, T, status, allTrucks };
