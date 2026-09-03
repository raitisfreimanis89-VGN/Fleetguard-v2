/* ============================================================================
   FleetGuard Toll Engine  —  self-contained US truck toll estimator
   ----------------------------------------------------------------------------
   No API, no key, no vendor. A hand-built graph of interstate corridors with
   per-facility class-5 toll rates, solved with Dijkstra for two objectives:
     'fast'  = fewest miles
     'cheap' = lowest (fuel + tolls)

   Truck profile is FIXED for the whole fleet (80k / 5 axles / 6.5 mpg).

   RATE MAINTENANCE: toll authorities raise rates every January 1 (Indiana now
   also on June 30). Update FACILITIES below and bump RATES_EFFECTIVE.
   conf:'v' = verified against the authority's 2026 published schedule
   conf:'e' = estimated from per-mile averages — treat as ballpark
   ========================================================================== */
(function (global) {
  'use strict';

  var RATES_EFFECTIVE = 'January 2026';

  /* Fleet truck profile — same for every unit, so these are not user inputs. */
  var TRUCK = {
    gvw: 80000, axles: 5,
    mpg: 6.5, fuelPrice: 6.00, speed: 65,
    transponder: 'I-PASS / E-ZPass'
  };

  /* ── Toll facilities ──────────────────────────────────────────────────────
     perMi = class-5 rate per mile WITH transponder (I-PASS is E-ZPass network)
     flat  = fixed barrier/bridge toll for a 5-axle combination              */
  var FACILITIES = {
    'ny-thruway':   { n: 'NY Thruway',            st: 'NY', hwy: 'I-90/I-87',  perMi: 0.27,  conf: 'e' },
    'mass-pike':    { n: 'Massachusetts Turnpike',st: 'MA', hwy: 'I-90',       perMi: 0.19,  conf: 'e' },
    'oh-tpk':       { n: 'Ohio Turnpike',         st: 'OH', hwy: 'I-80/90',    perMi: 0.226, conf: 'v' },
    'in-itr':       { n: 'Indiana Toll Road',     st: 'IN', hwy: 'I-80/90',    perMi: 0.557, conf: 'v' },
    'pa-tpk':       { n: 'Pennsylvania Turnpike', st: 'PA', hwy: 'I-76',       perMi: 0.35,  conf: 'v' },
    'il-tollway':   { n: 'Illinois Tollway',      st: 'IL', hwy: 'I-90/I-294', perMi: 0.22,  conf: 'e' },
    'skyway':       { n: 'Chicago Skyway',        st: 'IL', hwy: 'I-90',       flat: 31.50,  conf: 'e' },
    'nj-tpk':       { n: 'New Jersey Turnpike',   st: 'NJ', hwy: 'I-95',       perMi: 0.30,  conf: 'e' },
    'de-tpk':       { n: 'Delaware Turnpike',     st: 'DE', hwy: 'I-95',       flat: 10.50,  conf: 'e' },
    'md-jfk':       { n: 'MD JFK Memorial Hwy',   st: 'MD', hwy: 'I-95',       flat: 30.00,  conf: 'e' },
    'md-fmt':       { n: 'Fort McHenry Tunnel',   st: 'MD', hwy: 'I-95',       flat: 30.00,  conf: 'e' },
    'hudson':       { n: 'Hudson River crossing', st: 'NY', hwy: 'GWB/Tunnel', flat: 115.00, conf: 'e' },
    'wv-tpk':       { n: 'West Virginia Turnpike',st: 'WV', hwy: 'I-77',       flat: 47.00,  conf: 'e' },
    'ks-tpk':       { n: 'Kansas Turnpike',       st: 'KS', hwy: 'I-35/I-70',  perMi: 0.17,  conf: 'e' },
    'ok-turner':    { n: 'Turner Turnpike',       st: 'OK', hwy: 'I-44',       perMi: 0.16,  conf: 'e' },
    'ok-will':      { n: 'Will Rogers Turnpike',  st: 'OK', hwy: 'I-44',       perMi: 0.16,  conf: 'e' },
    'fl-tpk':       { n: "Florida's Turnpike",    st: 'FL', hwy: 'FL-91',      perMi: 0.28,  conf: 'e' },
    'me-tpk':       { n: 'Maine Turnpike',        st: 'ME', hwy: 'I-95',       perMi: 0.12,  conf: 'e' },
    'nh-tpk':       { n: 'NH Turnpike',           st: 'NH', hwy: 'I-95',       flat: 12.00,  conf: 'e' },
    'del-mem':      { n: 'Delaware Mem. Bridge',  st: 'DE', hwy: 'I-295/US-40',flat: 35.00,  conf: 'v' },
    'tz-bridge':    { n: 'Gov. Cuomo Bridge',     st: 'NY', hwy: 'I-287',      flat: 42.00,  conf: 'e' },
    /* DRJTBC Delaware River crossings bill WESTBOUND ONLY (into PA). The graph
       is undirected, so an eastbound-only trip will show this when it is
       actually free — see the directional-toll note on the page. */
    'dwg-bridge':   { n: 'Delaware Water Gap Br.',st: 'PA', hwy: 'I-80',       flat: 18.00,  conf: 'e' }
  };

  /* ── Corridor nodes: major interstate junction metros ───────────────────── */
  var NODES = {
    boston:{n:'Boston',s:'MA',lat:42.36,lon:-71.06},           portland_me:{n:'Portland',s:'ME',lat:43.66,lon:-70.26},
    hartford:{n:'Hartford',s:'CT',lat:41.76,lon:-72.67},        albany:{n:'Albany',s:'NY',lat:42.65,lon:-73.76},
    syracuse:{n:'Syracuse',s:'NY',lat:43.05,lon:-76.15},        buffalo:{n:'Buffalo',s:'NY',lat:42.89,lon:-78.88},
    nyc:{n:'New York',s:'NY',lat:40.71,lon:-74.01},             newark:{n:'Newark',s:'NJ',lat:40.74,lon:-74.17},
    philadelphia:{n:'Philadelphia',s:'PA',lat:39.95,lon:-75.17},scranton:{n:'Scranton',s:'PA',lat:41.41,lon:-75.66},
    harrisburg:{n:'Harrisburg',s:'PA',lat:40.27,lon:-76.88},    breezewood:{n:'Breezewood',s:'PA',lat:39.99,lon:-78.25},
    pittsburgh:{n:'Pittsburgh',s:'PA',lat:40.44,lon:-79.99},    wilmington_de:{n:'Wilmington',s:'DE',lat:39.74,lon:-75.55},
    baltimore:{n:'Baltimore',s:'MD',lat:39.29,lon:-76.61},      washington:{n:'Washington',s:'DC',lat:38.91,lon:-77.04},
    richmond:{n:'Richmond',s:'VA',lat:37.54,lon:-77.44},        roanoke:{n:'Roanoke',s:'VA',lat:37.27,lon:-79.94},
    bristol_va:{n:'Bristol',s:'VA',lat:36.60,lon:-82.19},       charleston_wv:{n:'Charleston',s:'WV',lat:38.35,lon:-81.63},
    erie:{n:'Erie',s:'PA',lat:42.13,lon:-80.09},                youngstown:{n:'Youngstown',s:'OH',lat:41.10,lon:-80.65},
    cleveland:{n:'Cleveland',s:'OH',lat:41.50,lon:-81.69},      toledo:{n:'Toledo',s:'OH',lat:41.65,lon:-83.54},
    oh_in_line:{n:'OH/IN line',s:'IN',lat:41.71,lon:-84.80},    south_bend:{n:'South Bend',s:'IN',lat:41.68,lon:-86.25},
    gary:{n:'Gary',s:'IN',lat:41.59,lon:-87.35},                chicago:{n:'Chicago',s:'IL',lat:41.88,lon:-87.63},
    detroit:{n:'Detroit',s:'MI',lat:42.33,lon:-83.05},          columbus:{n:'Columbus',s:'OH',lat:39.96,lon:-82.99},
    dayton:{n:'Dayton',s:'OH',lat:39.76,lon:-84.19},            cincinnati:{n:'Cincinnati',s:'OH',lat:39.10,lon:-84.51},
    indianapolis:{n:'Indianapolis',s:'IN',lat:39.77,lon:-86.16},louisville:{n:'Louisville',s:'KY',lat:38.25,lon:-85.76},
    milwaukee:{n:'Milwaukee',s:'WI',lat:43.04,lon:-87.91},      madison:{n:'Madison',s:'WI',lat:43.07,lon:-89.40},
    minneapolis:{n:'Minneapolis',s:'MN',lat:44.98,lon:-93.27},  des_moines:{n:'Des Moines',s:'IA',lat:41.59,lon:-93.62},
    omaha:{n:'Omaha',s:'NE',lat:41.26,lon:-95.93},              kansas_city:{n:'Kansas City',s:'MO',lat:39.10,lon:-94.58},
    st_louis:{n:'St. Louis',s:'MO',lat:38.63,lon:-90.20},       springfield_il:{n:'Springfield',s:'IL',lat:39.80,lon:-89.64},
    joplin:{n:'Joplin',s:'MO',lat:37.08,lon:-94.51},            wichita:{n:'Wichita',s:'KS',lat:37.69,lon:-97.34},
    tulsa:{n:'Tulsa',s:'OK',lat:36.15,lon:-95.99},              oklahoma_city:{n:'Oklahoma City',s:'OK',lat:35.47,lon:-97.52},
    memphis:{n:'Memphis',s:'TN',lat:35.15,lon:-90.05},          nashville:{n:'Nashville',s:'TN',lat:36.16,lon:-86.78},
    knoxville:{n:'Knoxville',s:'TN',lat:35.96,lon:-83.92},      chattanooga:{n:'Chattanooga',s:'TN',lat:35.05,lon:-85.31},
    atlanta:{n:'Atlanta',s:'GA',lat:33.75,lon:-84.39},          birmingham:{n:'Birmingham',s:'AL',lat:33.52,lon:-86.80},
    montgomery:{n:'Montgomery',s:'AL',lat:32.38,lon:-86.30},    mobile:{n:'Mobile',s:'AL',lat:30.69,lon:-88.04},
    jackson_ms:{n:'Jackson',s:'MS',lat:32.30,lon:-90.18},       new_orleans:{n:'New Orleans',s:'LA',lat:29.95,lon:-90.07},
    baton_rouge:{n:'Baton Rouge',s:'LA',lat:30.45,lon:-91.19},  shreveport:{n:'Shreveport',s:'LA',lat:32.53,lon:-93.75},
    little_rock:{n:'Little Rock',s:'AR',lat:34.75,lon:-92.29},  greensboro:{n:'Greensboro',s:'NC',lat:36.07,lon:-79.79},
    raleigh:{n:'Raleigh',s:'NC',lat:35.78,lon:-78.64},          charlotte:{n:'Charlotte',s:'NC',lat:35.23,lon:-80.84},
    columbia_sc:{n:'Columbia',s:'SC',lat:34.00,lon:-81.03},     savannah:{n:'Savannah',s:'GA',lat:32.08,lon:-81.09},
    jacksonville:{n:'Jacksonville',s:'FL',lat:30.33,lon:-81.66},orlando:{n:'Orlando',s:'FL',lat:28.54,lon:-81.38},
    tampa:{n:'Tampa',s:'FL',lat:27.95,lon:-82.46},              miami:{n:'Miami',s:'FL',lat:25.76,lon:-80.19},
    dallas:{n:'Dallas',s:'TX',lat:32.78,lon:-96.80},            fort_worth:{n:'Fort Worth',s:'TX',lat:32.76,lon:-97.33},
    houston:{n:'Houston',s:'TX',lat:29.76,lon:-95.37},          austin:{n:'Austin',s:'TX',lat:30.27,lon:-97.74},
    san_antonio:{n:'San Antonio',s:'TX',lat:29.42,lon:-98.49},  amarillo:{n:'Amarillo',s:'TX',lat:35.22,lon:-101.83},
    el_paso:{n:'El Paso',s:'TX',lat:31.76,lon:-106.49},         albuquerque:{n:'Albuquerque',s:'NM',lat:35.08,lon:-106.65},
    denver:{n:'Denver',s:'CO',lat:39.74,lon:-104.99},           cheyenne:{n:'Cheyenne',s:'WY',lat:41.14,lon:-104.82},
    casper:{n:'Casper',s:'WY',lat:42.87,lon:-106.31},           rapid_city:{n:'Rapid City',s:'SD',lat:44.08,lon:-103.23},
    sioux_falls:{n:'Sioux Falls',s:'SD',lat:43.55,lon:-96.73},  fargo:{n:'Fargo',s:'ND',lat:46.88,lon:-96.79},
    billings:{n:'Billings',s:'MT',lat:45.78,lon:-108.50},       missoula:{n:'Missoula',s:'MT',lat:46.87,lon:-113.99},
    salt_lake:{n:'Salt Lake City',s:'UT',lat:40.76,lon:-111.89},boise:{n:'Boise',s:'ID',lat:43.62,lon:-116.20},
    spokane:{n:'Spokane',s:'WA',lat:47.66,lon:-117.43},         seattle:{n:'Seattle',s:'WA',lat:47.61,lon:-122.33},
    portland_or:{n:'Portland',s:'OR',lat:45.52,lon:-122.68},    sacramento:{n:'Sacramento',s:'CA',lat:38.58,lon:-121.49},
    san_francisco:{n:'San Francisco',s:'CA',lat:37.77,lon:-122.42}, reno:{n:'Reno',s:'NV',lat:39.53,lon:-119.81},
    las_vegas:{n:'Las Vegas',s:'NV',lat:36.17,lon:-115.14},     los_angeles:{n:'Los Angeles',s:'CA',lat:34.05,lon:-118.24},
    san_diego:{n:'San Diego',s:'CA',lat:32.72,lon:-117.16},     barstow:{n:'Barstow',s:'CA',lat:34.90,lon:-117.02},
    flagstaff:{n:'Flagstaff',s:'AZ',lat:35.20,lon:-111.65},     phoenix:{n:'Phoenix',s:'AZ',lat:33.45,lon:-112.07},
    tucson:{n:'Tucson',s:'AZ',lat:32.22,lon:-110.97}
  };

  /* ── Corridor edges ───────────────────────────────────────────────────────
     [a, b, miles, highway, tollFacilityId|null, tolledMiles|null]
     tolledMiles defaults to the full edge length when omitted.
     Parallel edges (same pair, different highway) let the solver choose
     between a toll road and its free alternative — that is the whole point. */
  var EDGES = [
    /* I-90 / I-80 northern spine ------------------------------------------ */
    ['boston','albany',170,'I-90','mass-pike',138],
    ['albany','syracuse',145,'I-90','ny-thruway'],
    ['syracuse','buffalo',155,'I-90','ny-thruway'],
    ['buffalo','erie',90,'I-90','ny-thruway',68],
    ['erie','cleveland',100,'I-90',null],
    ['cleveland','toledo',115,'I-80/90 OH Tpk','oh-tpk',93],
    ['cleveland','toledo',118,'US-20/SR-2',null],
    ['toledo','oh_in_line',55,'I-80/90 OH Tpk','oh-tpk'],
    ['oh_in_line','south_bend',80,'I-80/90 ITR','in-itr'],
    ['south_bend','gary',60,'I-80/90 ITR','in-itr'],
    ['toledo','south_bend',140,'US-20/US-6',null],
    ['south_bend','gary',62,'US-20',null],
    ['gary','chicago',27,'I-90 Skyway','skyway'],
    ['gary','chicago',32,'I-80/94',null],
    ['chicago','des_moines',333,'I-80',null],
    ['des_moines','omaha',135,'I-80',null],
    ['omaha','cheyenne',490,'I-80',null],
    ['cheyenne','salt_lake',440,'I-80',null],
    ['salt_lake','reno',520,'I-80',null],
    ['reno','sacramento',130,'I-80',null],

    /* I-80 across PA — the free alternative to the PA Turnpike ------------- */
    ['youngstown','scranton',290,'I-80',null],
    /* I-80 east dead-ends at the GWB: there is no free way into Manhattan
       from the west, so the crossing toll rides on this edge. */
    ['scranton','nyc',120,'I-80/GWB','hudson'],
    /* I-80 reaches northern NJ without crossing the Hudson — freight bound for
       the NJ warehouse belt must not be charged a GWB toll it never pays. */
    ['scranton','newark',95,'I-80','dwg-bridge'],
    /* I-84/I-287 over the Cuomo (Tappan Zee) Bridge — the standard truck way
       around New York City, and far cheaper than the Hudson crossings. */
    ['hartford','newark',150,'I-84/I-287 Cuomo Br.','tz-bridge'],

    /* PA Turnpike / I-76 -------------------------------------------------- */
    ['pittsburgh','harrisburg',200,'I-76 PA Tpk','pa-tpk',180],
    ['harrisburg','philadelphia',105,'I-76 PA Tpk','pa-tpk',90],
    ['pittsburgh','breezewood',120,'I-70/76 PA Tpk','pa-tpk',86],
    ['breezewood','baltimore',130,'I-70',null],
    ['harrisburg','baltimore',85,'I-83',null],
    ['harrisburg','scranton',120,'I-81',null],
    ['scranton','syracuse',175,'I-81',null],

    /* I-95 north-east corridor -------------------------------------------- */
    ['portland_me','boston',110,'I-95','me-tpk',95],
    ['boston','hartford',100,'I-90/I-84',null],
    ['hartford','nyc',115,'I-91/I-95',null],
    ['newark','nyc',12,'GWB / Tunnel','hudson'],
    ['philadelphia','newark',85,'I-95 NJ Tpk','nj-tpk'],
    ['philadelphia','wilmington_de',30,'I-95','de-tpk'],
    ['wilmington_de','baltimore',70,'I-95','md-jfk'],
    /* I-95 through Baltimore runs the tolled Fort McHenry Tunnel; I-695 west
       is the free way around it (and the hazmat-legal one). */
    ['baltimore','washington',40,'I-95 Fort McHenry','md-fmt'],
    ['baltimore','washington',48,'I-695/I-95 west',null],
    /* NJ Turnpike south to the Delaware Memorial Bridge — the route that
       bypasses Philadelphia entirely. */
    ['newark','wilmington_de',105,'NJ Tpk / Del. Mem. Br.','del-mem'],
    /* PA Turnpike Northeast Extension */
    ['philadelphia','scranton',115,'I-476 PA Tpk NE Ext','pa-tpk',95],
    ['washington','richmond',105,'I-95',null],
    ['richmond','raleigh',155,'I-85/I-95',null],
    ['richmond','savannah',480,'I-95',null],
    ['savannah','jacksonville',140,'I-95',null],
    ['jacksonville','orlando',140,'I-95/I-4',null],
    ['orlando','miami',235,'FL Tpk','fl-tpk',215],
    ['orlando','miami',250,'I-95',null],
    ['orlando','tampa',85,'I-4',null],

    /* Appalachian / I-77 / I-81 ------------------------------------------- */
    ['charleston_wv','bristol_va',180,'I-77/I-81','wv-tpk'],
    ['charleston_wv','columbus',160,'I-77/I-70',null],
    ['pittsburgh','charleston_wv',215,'I-79',null],
    ['bristol_va','roanoke',145,'I-81',null],
    ['roanoke','harrisburg',300,'I-81',null],
    ['roanoke','richmond',190,'I-81/I-64',null],
    ['bristol_va','knoxville',130,'I-81',null],

    /* Great Lakes / I-75 / I-71 ------------------------------------------- */
    ['pittsburgh','youngstown',70,'I-76',null],
    ['youngstown','cleveland',75,'I-80/I-77',null],
    ['cleveland','columbus',140,'I-71',null],
    ['columbus','cincinnati',110,'I-71',null],
    ['columbus','indianapolis',175,'I-70',null],
    ['columbus','dayton',72,'I-70',null],
    ['dayton','cincinnati',55,'I-75',null],
    ['toledo','dayton',150,'I-75',null],
    ['detroit','toledo',60,'I-75',null],
    ['detroit','chicago',285,'I-94',null],
    ['detroit','cleveland',170,'I-75/I-80',null],
    ['cincinnati','knoxville',275,'I-75',null],
    ['cincinnati','louisville',100,'I-71',null],
    ['indianapolis','louisville',115,'I-65',null],
    ['gary','indianapolis',150,'I-65',null],
    ['indianapolis','st_louis',240,'I-70',null],

    /* Upper Midwest -------------------------------------------------------- */
    ['chicago','milwaukee',90,'I-94','il-tollway',18],
    ['chicago','madison',148,'I-90','il-tollway',76],
    ['milwaukee','madison',80,'I-94',null],
    ['madison','minneapolis',270,'I-94',null],
    ['milwaukee','minneapolis',335,'I-94',null],
    ['minneapolis','des_moines',245,'I-35',null],
    ['minneapolis','fargo',240,'I-94',null],
    ['minneapolis','sioux_falls',240,'I-90',null],
    ['sioux_falls','rapid_city',350,'I-90',null],
    ['rapid_city','billings',350,'I-90',null],
    ['billings','missoula',345,'I-90',null],
    ['missoula','spokane',200,'I-90',null],
    ['spokane','seattle',280,'I-90',null],
    ['fargo','billings',580,'I-94',null],
    ['cheyenne','rapid_city',300,'US-85',null],
    ['cheyenne','casper',180,'I-25',null],

    /* Mississippi valley / I-55 / I-57 ------------------------------------ */
    ['chicago','springfield_il',200,'I-55',null],
    ['springfield_il','st_louis',100,'I-55',null],
    ['st_louis','memphis',285,'I-55',null],
    ['memphis','jackson_ms',210,'I-55',null],
    ['jackson_ms','new_orleans',185,'I-55/I-10',null],
    ['st_louis','kansas_city',250,'I-70',null],
    ['kansas_city','des_moines',195,'I-35',null],
    ['kansas_city','omaha',185,'I-29',null],

    /* I-44 / I-35 / Plains -------------------------------------------------- */
    ['st_louis','joplin',285,'I-44',null],
    ['joplin','tulsa',115,'I-44 Will Rogers','ok-will',88],
    ['tulsa','oklahoma_city',105,'I-44 Turner','ok-turner',86],
    ['kansas_city','wichita',200,'I-35 KS Tpk','ks-tpk',130],
    ['wichita','oklahoma_city',160,'I-35',null],
    ['kansas_city','denver',600,'I-70',null],
    ['wichita','denver',520,'US-400/I-70',null],
    ['denver','cheyenne',100,'I-25',null],
    ['denver','salt_lake',520,'I-70/I-15',null],
    ['denver','albuquerque',450,'I-25',null],

    /* Southeast ------------------------------------------------------------ */
    ['memphis','nashville',210,'I-40',null],
    ['memphis','little_rock',135,'I-40',null],
    ['little_rock','oklahoma_city',340,'I-40',null],
    ['little_rock','shreveport',220,'I-30/I-49',null],
    ['nashville','knoxville',180,'I-40',null],
    ['nashville','chattanooga',135,'I-24',null],
    ['nashville','louisville',175,'I-65',null],
    ['nashville','birmingham',190,'I-65',null],
    ['knoxville','chattanooga',110,'I-75',null],
    ['chattanooga','atlanta',120,'I-75',null],
    ['atlanta','birmingham',150,'I-20',null],
    ['atlanta','charlotte',245,'I-85',null],
    ['atlanta','columbia_sc',215,'I-20',null],
    ['atlanta','savannah',250,'I-16/I-75',null],
    ['atlanta','jacksonville',345,'I-75/I-10',null],
    ['atlanta','tampa',455,'I-75',null],
    ['charlotte','greensboro',95,'I-85',null],
    ['greensboro','raleigh',80,'I-40',null],
    ['greensboro','richmond',215,'I-85/I-95',null],
    ['charlotte','columbia_sc',95,'I-77',null],
    ['columbia_sc','savannah',160,'I-95',null],
    ['birmingham','montgomery',90,'I-65',null],
    ['montgomery','mobile',170,'I-65',null],
    ['mobile','new_orleans',145,'I-10',null],
    ['mobile','jacksonville',400,'I-10',null],
    ['birmingham','jackson_ms',240,'I-20',null],

    /* Texas / Gulf / Southwest -------------------------------------------- */
    ['new_orleans','baton_rouge',80,'I-10',null],
    ['baton_rouge','houston',270,'I-10',null],
    ['shreveport','dallas',190,'I-20',null],
    ['jackson_ms','shreveport',200,'I-20',null],
    ['oklahoma_city','dallas',205,'I-35',null],
    ['dallas','fort_worth',33,'I-30',null],
    ['dallas','houston',240,'I-45',null],
    ['dallas','austin',195,'I-35',null],
    ['austin','san_antonio',80,'I-35',null],
    ['houston','san_antonio',200,'I-10',null],
    ['san_antonio','el_paso',550,'I-10',null],
    ['fort_worth','amarillo',345,'US-287',null],
    ['oklahoma_city','amarillo',260,'I-40',null],
    ['amarillo','albuquerque',290,'I-40',null],
    ['albuquerque','flagstaff',325,'I-40',null],
    ['albuquerque','el_paso',265,'I-25',null],
    ['el_paso','tucson',320,'I-10',null],
    ['tucson','phoenix',115,'I-10',null],
    ['phoenix','flagstaff',145,'I-17',null],
    ['phoenix','los_angeles',370,'I-10',null],
    ['flagstaff','barstow',305,'I-40',null],
    ['barstow','los_angeles',130,'I-15',null],
    ['barstow','las_vegas',155,'I-15',null],
    ['las_vegas','salt_lake',420,'I-15',null],

    /* West coast / Northwest ---------------------------------------------- */
    ['los_angeles','san_diego',120,'I-5',null],
    ['los_angeles','sacramento',385,'I-5',null],
    ['sacramento','san_francisco',90,'I-80',null],
    ['sacramento','portland_or',580,'I-5',null],
    ['portland_or','seattle',175,'I-5',null],
    ['portland_or','boise',430,'I-84',null],
    ['boise','salt_lake',340,'I-84/I-15',null],
    ['salt_lake','billings',550,'I-15/I-90',null]
  ];

  /* ── ZIP3 prefix → corridor node ──────────────────────────────────────────
     [lowPrefix, highPrefix, nodeId]. Metro-level resolution: precise enough,
     because tolls accrue on the corridors between metros, not the last mile. */
  var ZIP3 = [
    [10,27,'boston'],[28,29,'boston'],[30,38,'boston'],[39,49,'portland_me'],
    [50,59,'albany'],[60,69,'hartford'],[70,89,'newark'],[100,119,'nyc'],
    [120,129,'albany'],[130,139,'syracuse'],[140,149,'buffalo'],[150,168,'pittsburgh'],
    [169,178,'harrisburg'],[179,189,'scranton'],[190,196,'philadelphia'],[197,199,'wilmington_de'],
    [200,205,'washington'],[206,212,'baltimore'],[214,219,'baltimore'],[220,229,'washington'],
    [230,239,'richmond'],[240,246,'roanoke'],[247,268,'charleston_wv'],[270,279,'greensboro'],
    [280,289,'charlotte'],[290,299,'columbia_sc'],[300,319,'atlanta'],[320,326,'jacksonville'],
    [327,329,'orlando'],[330,334,'miami'],[335,339,'tampa'],[340,349,'orlando'],
    [350,369,'birmingham'],[370,379,'nashville'],[380,385,'memphis'],[386,397,'jackson_ms'],
    [398,399,'atlanta'],[400,427,'louisville'],[430,439,'columbus'],[440,449,'cleveland'],
    [450,459,'cincinnati'],[460,469,'indianapolis'],[470,479,'indianapolis'],[480,489,'detroit'],
    [490,499,'detroit'],[500,528,'des_moines'],[530,539,'milwaukee'],[540,549,'madison'],
    [550,567,'minneapolis'],[570,577,'sioux_falls'],[580,588,'fargo'],[590,599,'billings'],
    [600,609,'chicago'],[610,629,'springfield_il'],[630,639,'st_louis'],[640,658,'kansas_city'],
    [660,669,'kansas_city'],[670,679,'wichita'],[680,693,'omaha'],[700,701,'new_orleans'],
    [703,708,'baton_rouge'],[710,714,'shreveport'],[716,729,'little_rock'],[730,739,'oklahoma_city'],
    [740,749,'tulsa'],[750,759,'dallas'],[760,769,'fort_worth'],[770,778,'houston'],
    [779,789,'san_antonio'],[790,799,'amarillo'],[800,816,'denver'],[820,831,'cheyenne'],
    [832,838,'boise'],[840,847,'salt_lake'],[850,860,'phoenix'],[861,865,'tucson'],
    [870,884,'albuquerque'],[885,885,'el_paso'],[889,898,'las_vegas'],[900,935,'los_angeles'],
    [936,953,'sacramento'],[954,961,'san_francisco'],[970,979,'portland_or'],[980,989,'seattle'],
    [990,994,'spokane']
    /* 967-968 (HI) and 995-999 (AK) are deliberately absent — not drivable. */
  ];

  /* ── Graph build ─────────────────────────────────────────────────────────── */
  var ADJ = {};
  EDGES.forEach(function (e) {
    var a = e[0], b = e[1];
    var rec = { mi: e[2], hwy: e[3], toll: e[4] || null, tmi: (e[5] == null ? e[2] : e[5]) };
    (ADJ[a] = ADJ[a] || []).push({ to: b, e: rec });
    (ADJ[b] = ADJ[b] || []).push({ to: a, e: rec });
  });

  function edgeToll(e) {
    if (!e.toll) return 0;
    var f = FACILITIES[e.toll];
    if (!f) return 0;
    return f.flat != null ? f.flat : e.tmi * f.perMi;
  }

  var fuelPerMile = function () { return TRUCK.fuelPrice / TRUCK.mpg; };

  /* Dijkstra. mode 'fast' minimises miles; 'cheap' minimises fuel + tolls. */
  function solve(from, to, mode) {
    if (!NODES[from] || !NODES[to]) return null;
    if (from === to) return { nodes: [from], legs: [], mi: 0, toll: 0 };

    var fpm = fuelPerMile();
    var dist = {}, prev = {}, seen = {};
    Object.keys(NODES).forEach(function (k) { dist[k] = Infinity; });
    dist[from] = 0;

    while (true) {
      var u = null, best = Infinity;
      for (var k in dist) { if (!seen[k] && dist[k] < best) { best = dist[k]; u = k; } }
      if (u === null || u === to) break;
      seen[u] = true;

      (ADJ[u] || []).forEach(function (link) {
        var w = mode === 'cheap' ? (link.e.mi * fpm + edgeToll(link.e)) : link.e.mi;
        var nd = dist[u] + w;
        if (nd < dist[link.to]) { dist[link.to] = nd; prev[link.to] = { from: u, e: link.e }; }
      });
    }
    if (dist[to] === Infinity) return null;

    var nodes = [to], legs = [], cur = to;
    while (prev[cur]) { legs.unshift({ a: prev[cur].from, b: cur, e: prev[cur].e }); cur = prev[cur].from; nodes.unshift(cur); }

    var mi = 0, toll = 0;
    legs.forEach(function (l) { mi += l.e.mi; toll += edgeToll(l.e); });
    return { nodes: nodes, legs: legs, mi: mi, toll: toll };
  }

  /* Roll consecutive legs on the same facility into one line item. */
  function tollBreakdown(route) {
    var out = [], byId = {};
    route.legs.forEach(function (l) {
      if (!l.e.toll) return;
      var f = FACILITIES[l.e.toll];
      if (!f) return;
      if (!byId[l.e.toll]) {
        byId[l.e.toll] = { id: l.e.toll, name: f.n, st: f.st, hwy: f.hwy, conf: f.conf, mi: 0, cost: 0, flat: f.flat != null };
        out.push(byId[l.e.toll]);
      }
      var b = byId[l.e.toll];
      if (f.flat != null) { if (b.cost === 0) b.cost = f.flat; }
      else { b.mi += l.e.tmi; b.cost += l.e.tmi * f.perMi; }
    });
    return out;
  }

  function summarise(route) {
    if (!route) return null;
    var fuel = route.mi * fuelPerMile();
    var hrs = route.mi / TRUCK.speed;
    return {
      miles: route.mi,
      hours: hrs,
      days: Math.max(1, Math.ceil(hrs / 11)),
      tolls: route.toll,
      fuel: fuel,
      total: route.toll + fuel,
      perMile: route.mi ? (route.toll + fuel) / route.mi : 0,
      tollPerMile: route.mi ? route.toll / route.mi : 0,
      breakdown: tollBreakdown(route),
      via: route.nodes.map(function (n) { return NODES[n].n + ', ' + NODES[n].s; }),
      hwys: route.legs.map(function (l) { return l.e.hwy; })
        .filter(function (h, i, a) { return h && a.indexOf(h) === i; })
    };
  }

  /* ── Public API ──────────────────────────────────────────────────────────── */
  function resolve(input) {
    if (!input) return null;
    var q = String(input).trim();

    var z = q.match(/^(\d{3})\d{0,2}$/);
    if (z) {
      var p = parseInt(z[1], 10);
      for (var i = 0; i < ZIP3.length; i++) {
        if (p >= ZIP3[i][0] && p <= ZIP3[i][1]) {
          var id = ZIP3[i][2];
          return { id: id, label: NODES[id].n + ', ' + NODES[id].s, via: 'ZIP ' + q, exact: false };
        }
      }
      return null;
    }

    var needle = q.toLowerCase().replace(/[^a-z]/g, '');
    var hit = null;
    Object.keys(NODES).forEach(function (id) {
      if (hit) return;
      var nm = NODES[id].n.toLowerCase().replace(/[^a-z]/g, '');
      if (nm === needle || nm.indexOf(needle) === 0) hit = id;
    });
    if (!hit) return null;
    return { id: hit, label: NODES[hit].n + ', ' + NODES[hit].s, via: 'city', exact: true };
  }

  function quote(fromInput, toInput) {
    var a = resolve(fromInput), b = resolve(toInput);
    if (!a) return { error: 'Could not place origin "' + fromInput + '".' };
    if (!b) return { error: 'Could not place destination "' + toInput + '".' };
    if (a.id === b.id) return { error: 'Origin and destination resolve to the same metro (' + a.label + ').' };

    var fast = summarise(solve(a.id, b.id, 'fast'));
    var cheap = summarise(solve(a.id, b.id, 'cheap'));
    if (!fast) return { error: 'No corridor route found between those points.' };

    var same = Math.abs(fast.miles - cheap.miles) < 1 && Math.abs(fast.tolls - cheap.tolls) < 0.5;
    var alt = null;
    if (!same) {
      var addMi = cheap.miles - fast.miles;
      var saveToll = fast.tolls - cheap.tolls;
      alt = {
        addedMiles: addMi,
        addedHours: addMi / TRUCK.speed,
        tollSaved: saveToll,
        netSaving: cheap.total - fast.total,
        worthIt: cheap.total < fast.total
      };
    }
    return { from: a, to: b, fast: fast, cheap: cheap, sameRoute: same, alt: alt };
  }

  global.TollEngine = {
    quote: quote, resolve: resolve,
    TRUCK: TRUCK, FACILITIES: FACILITIES, NODES: NODES,
    RATES_EFFECTIVE: RATES_EFFECTIVE,
    fuelPerMile: fuelPerMile,
    setFuel: function (price, mpg) {
      if (price > 0) TRUCK.fuelPrice = price;
      if (mpg > 0) TRUCK.mpg = mpg;
    }
  };
})(window);
