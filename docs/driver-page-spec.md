# FleetGuard — Drivers Page (Pre-Trip Inspection) — Spec v0.1

> Status: **prototype + design**. Prototype = `driver.html` (self-contained, mocked backend).
> Nothing here is wired to Supabase or the SMS service yet. Reviewed before building the real thing.

---

## 1. Why this design fits FleetGuard

It reuses what already exists rather than inventing a parallel system:

| Existing piece | How the Drivers Page uses it |
|---|---|
| `driver_phones` table (E.164, admin-only, isolated) | Source of truth for OTP login — looked up by an Edge Function via `service_role`. |
| `gvoice-sms-service` `POST /send` (secret-protected) | Sends the OTP and the confirmation SMS — **same path** the reminder Edge Function already uses. |
| `tyre_records.readings` JSON `[{axleIndex,position,status}]` | The driver submission writes this **exact shape** (Pass→`good`, Fail→`bad`) so the dispatcher app renders it with no change, plus enriched fields (`rating`, `hasPhoto`). |
| `AXLES` (Steer + 2 Drive + 2 Trailer = 18 tyres) | Identical model in the Drivers Page. |
| `mileage_records` (driver INSERT already allowed by RLS) | Odometer reading is written here. |
| Design tokens (`--primary #da6536`, Manrope/Inter, cards/badges/toggles) | Drivers Page matches the look so it feels like one product. |

**Key architecture decision:** drivers have **no Supabase Auth account**. The browser holds only a short-lived *driver session token* and talks **only to Edge Functions** — never directly to Postgres. This keeps the current RLS surface (anon/authenticated) completely untouched and means a driver's device can never read/write tables directly.

---

## 2. Screens / wireframes (as built in the prototype)

```
0. SIGN-IN (OTP)      cell # → "Send code" → 6-digit boxes → verify
                      resend timer 30s · masked number · privacy note
1. VEHICLE            Truck # (prefilled from SMS link ?v=) · Trailer (opt)
                      recent-unit chips · "walk-around timer starts" note
2. TYRE TREAD CHECK   side-view truck diagram (5 axle dots: green / red / grey)
                      per axle card → per tyre: Pass / Fail (44px targets)
                      optional photo · "Pass axle" shortcut
                      live counter x/18 · missing axles highlighted on Continue
3. SAFETY CHECKS      5 cards: Air leak · Windshield · Hub leaks · ABS · Check-engine
                      Pass / Fail / N-A · Fail reveals Severity (Minor/Major/Critical)
                      + photo + note
4. REVIEW & SIGN      summary (verdict, tyre tally, failed items, photos, duration,
                      start time) · odometer · GPS capture · signature pad · notes
                      Save draft | Submit (label flips to "Queue" when offline)
5. CONFIRMATION       ✅ Submitted / 📥 Queued · reference FG-INSP-#### · tallies
                      "confirmation text on its way" · Start another
```

Global: demo ribbon, online/offline pill, 5-segment progress bar, walk-around timer, toast.

---

## 3. API contract (to build)

All endpoints are **Supabase Edge Functions**. The browser never holds the `service_role` key or the gvoice secret.

> **Sending is admin-initiated only.** The driver-portal link is texted **only when an admin explicitly requests it** from the dispatcher app — never on a schedule, never automatically, never without an admin action. There is **no cron/auto-send** for inspection links. Every send is role-gated (`is_admin()`) and audited. (The OTP code is the one outbound that's *driver*-triggered — sent only in response to the driver entering their own number on the page.)

### 3.0 `POST /functions/v1/driver-send-link` (admin only)
```jsonc
// request — caller must present an admin Supabase JWT
{ "driverId": "uuid", "vehicleId": "uuid" }
// response
{ "ok": true, "sentTo": "(•••) •••-2302" }
```
Logic: verify caller `is_admin()`; mint a short-lived link token bound to driverId+vehicleId; write an audit row (`who, when, driver, vehicle`); call gvoice `POST /send` with the unique portal link. Returns **401 for non-admins**. Rate-limited. **This is the only way a link goes out.**

### 3.1 `POST /functions/v1/driver-otp-request`
```jsonc
// request
{ "phone": "+12625550192" }
// response (ALWAYS generic — no account enumeration)
{ "ok": true }
```
Logic (service_role): find `driver_phones.phone_number = phone`. If found → generate 6-digit code, store `driver_otp_codes{ phone, code_hash, expires_at = now()+5min, attempts:0 }`, then call gvoice `POST /send` with `{to:phone, body:"FleetGuard code: 123456 (5 min)"}`. Rate-limit per phone+IP. If not found → still return `{ok:true}`, send nothing.

### 3.2 `POST /functions/v1/driver-otp-verify`
```jsonc
// request
{ "phone": "+12625550192", "code": "123456" }
// response
{ "ok": true,
  "token": "<driver session JWT, exp ~12h>",
  "driver": { "id": "uuid", "name": "Jane D." },
  "vehicles": [ { "id":"uuid", "truckNumber":"1024", "trailerNumber":"TR-5567" } ] }
```
Verify hash + expiry + attempts (max 5). On success mint a signed token (subject = driver_id, role = `driver`). On failure `{ok:false}` + increment attempts.

### 3.3 `POST /functions/v1/driver-inspection`
`Authorization: Bearer <driver token>`
```jsonc
// request (client generates inspectionId + idempotency)
{
  "inspectionId": "uuid",
  "truckNumber": "1024", "trailerNumber": "TR-5567",
  "odometer": 412350,
  "startedAt": "2026-06-09T13:10:50Z", "durationSec": 182,
  "gps": { "lat": 43.04, "lng": -87.91, "acc": 12 },
  "tyres": [ { "axleIndex":0, "position":"left", "status":"good",
              "rating":"pass", "photoId": null }, … 18 ],   // status: good|bad
  "checks": [ { "id":"windshield", "result":"fail",
               "severity":"Major", "photoId":"…", "note":"chip" }, … 5 ],
  "signatureId": "…", "finalNotes": null
}
// response
{ "ok": true, "ref": "FG-INSP-7788" }
```
Logic (service_role, verify token first; **upsert by `inspectionId`** so retries don't duplicate):
1. insert `inspections` header row
2. insert `tyre_records{ vehicle_id, photo_date, readings }` — readings = the `tyres` array (status stays `good/uneven/bad`)
3. insert `mileage_records{ vehicle_id, driver_id, mileage, date }`
4. persist failed checks → `inspection_items` (or JSONB on the header)
5. move photos/signature from temp upload to permanent Storage paths
6. insert a confirmation `sms_notifications` row / call gvoice `/send`
7. return `ref`

### 3.4 Photo upload
Bucket `inspection-photos` (private). Edge Function issues short-lived **signed upload URLs**; client PUTs compressed JPEGs (already compressed to ≤1024px / q0.7 in the prototype). Offline: photos held as blobs in IndexedDB, uploaded on sync, then `driver-inspection` is called with the resulting `photoId`s.

---

## 4. New database objects

```sql
-- short-lived OTP codes (service_role only)
create table driver_otp_codes (
  phone text not null, code_hash text not null,
  expires_at timestamptz not null, attempts int not null default 0,
  created_at timestamptz not null default now()
);

-- inspection header
create table inspections (
  id uuid primary key,                 -- client-generated (idempotency)
  ref text unique not null,            -- FG-INSP-####
  vehicle_id uuid references vehicles(id) on delete set null,
  driver_id  uuid references drivers(id)  on delete set null,
  started_at timestamptz, submitted_at timestamptz default now(),
  duration_sec int,                    -- walk-around time (anti-cab-cheat)
  odometer int check (odometer > 0 and odometer <= 9999999),
  gps_lat double precision, gps_lng double precision, gps_accuracy real,
  overall_result text check (overall_result in ('roadworthy','minor','defect')),
  signature_url text, notes text,
  created_at timestamptz default now()
);
-- inspection detail (tyres + checks), optional if you prefer JSONB on header
create table inspection_items (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid references inspections(id) on delete cascade,
  kind text check (kind in ('tyre','check')),
  item_key text, result text, severity text,
  tread_32 int, photo_url text, note text
);
-- RLS: authenticated SELECT (dispatchers/admins see them); INSERT via service_role only.
```

`tyre_records` and `mileage_records` are reused as-is.

---

## 5. Validation rules

| Field | Rule |
|---|---|
| Phone | 10-digit US / E.164; `Send code` disabled until valid |
| OTP | 6 digits; expires 5 min; max 5 attempts; resend cooldown 30 s |
| Truck # | required before leaving Vehicle screen |
| Tyres | each tyre **Pass / Fail**; all 18 marked before Continue; missing axles highlighted + scrolled to |
| Photos | optional everywhere (including failures) |
| Safety checks | all 5 answered; any **Fail ⇒ severity required** |
| Odometer | 1–9,999,999 (matches existing DB CHECK) |
| Signature | required to submit |
| GPS | capture attempted at submit; submission allowed if denied |
| Duration | always recorded; gentle warning if < 120 s |

---

## 6. Offline behaviour

- **Draft autosave** to `localStorage` on every change; reopening resumes at the saved step. Draft is cleared on successful submit (and on the confirmation screen).
- **Photos** kept in IndexedDB as blobs while offline.
- **Submit offline** → report enqueued locally; confirmation shows *Queued for upload*.
- **Auto-sync** on the browser `online` event; **exponential backoff** on failures.
- **Idempotency:** client-generated `inspectionId` + server upsert ⇒ retries never duplicate.
- **Service worker** caches the app shell ⇒ first paint < 3 s on 4G and the page opens even with no signal after first load.

---

## 7. Integrating "it's done" into the dispatcher app

So dispatch can see a completed pre-trip. **Chosen: Both** — the vehicle-level views below **and** a dedicated fleet-wide Inspections page (new sidebar item, alongside the existing hidden "Reminders" / "Driver Portal" slots):

1. **Vehicle card / Dispatch Board pill** — green `Pre-trip ✓ 07:14` when an inspection exists for today, amber `Pre-trip due` otherwise. Fold into `getVehicleStatus()`.
2. **Vehicle detail → Pre-Trip section** — list recent driver inspections: date, driver, result, **duration**, defects, photo thumbnails, GPS, signature.
3. **Realtime** — subscribe to `inspections` INSERT (Supabase realtime, already in the stack) → toast + badge for dispatchers.
4. **Defect routing** — a `defect`/Critical inspection can raise an alert (reuse the existing urgent-alert UI) and optionally a reminder/escalation row.
5. **Duration visible** — `duration_sec` surfaced so a 20-second "from the cab" inspection is obvious.

---

## 8. Security & privacy

- TLS for every hop (Supabase, Edge Functions, gvoice over HTTPS).
- Phone numbers stay in `driver_phones` (already isolated + admin-only); OTP codes are **hashed**, 5-min TTL.
- Driver token is short-lived and scoped to one `driver_id`; **drivers never get a DB client**, so existing RLS is unchanged.
- gvoice secret + `service_role` key live only in Edge Functions, never in the browser.
- Photos/GPS stored only on the inspection record; minimal PII; no account enumeration on OTP request.
- **Link dispatch is admin-initiated only** — `is_admin()`-gated, explicit per send, audited; **no scheduled/automated sending** of driver-portal links.

---

## 9. Acceptance criteria

- [ ] Driver opens SMS link → page loads < 3 s on 4G.
- [ ] Login by cell #, OTP via SMS (gvoice); wrong/expired code rejected; resend after 30 s.
- [ ] Vehicle prefilled from link; can be changed; truck # required.
- [ ] All 18 tyres must be rated; missing ones blocked + highlighted.
- [ ] 5 safety checks answered; failures force a severity; notes/photos attachable.
- [ ] Review shows verdict, tyre tally, failed items, photo count, **walk-around duration**, GPS, odometer, signature.
- [ ] Odometer 1–9,999,999 and signature required to submit.
- [ ] Online submit → record in `inspections` + `tyre_records` + `mileage_records`; confirmation SMS; reference shown.
- [ ] Offline submit → queued locally, auto-syncs on reconnect, **no duplicates** on retry.
- [ ] Dispatcher app shows the completed pre-trip (pill + detail + duration) in (near) realtime.
- [ ] Accessibility: ≥44 px targets, high contrast, screen-reader labels.
- [ ] No `service_role` key or SMS secret in client code.
- [ ] Driver-portal links send **only on explicit admin request** (role-gated + audited); no automated/scheduled link sends.

---

## 10. Decisions (locked 2026-06-09)

1. **OTP delivery** — ✅ Reuse the **Google Voice service** (same path as reminders; no new vendor/cost). Login code may take a few seconds to arrive.
2. **Tread capture** — ✅ **Pass / Fail per tyre** (no tread-depth numbers). Maps to `tyre_records` status `good`/`bad`.
3. **Photos** — ✅ **Optional everywhere** (including failures).
4. **"Done" visibility** — ✅ **Both**: vehicle-card pill + vehicle-detail history **and** a dedicated fleet-wide Inspections page.
5. **Link sending** — ✅ **Admin-initiated only.** Links go out solely on an explicit admin request (role-gated + audited); **no automated or scheduled sending** of driver-portal links. **Scope: driver-portal/inspection links only** — the existing reminder auto-send (`scheduler.js`, ~10 min) is a separate, accepted feature and stays unchanged.
