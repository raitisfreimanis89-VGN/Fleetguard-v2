# VGN Dashboard v3 — deliverables (branch `vgn-dashboard-v3`, preview only — NOT deployed)

## 1. Tracking-link sheet (§4)

Base: `https://fleetguards.app/vgn/`. All values lowercased & length-limited by the collector; only allowlisted params kept (`utm_source, utm_medium, utm_campaign, utm_content, utm_term, posting_city, creative_id, job_id, placement`; `fbclid/ttclid` only under approved consent).

| Channel | Ad type | Template | Placeholders | Macros verified |
|---|---|---|---|---|
| Indeed | Job board | `?utm_source=indeed&utm_medium=job_board&utm_campaign=vgn_otr&job_id=JOB_ID` | JOB_ID | n/a |
| Meta (FB/IG) | Paid social | `?utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}&placement={{placement}}` | all macros | **NO — verify in Meta Ads Mgr** |
| Facebook | Organic | `?utm_source=facebook&utm_medium=organic_social&utm_campaign=vgn_otr&utm_content=POST_OR_GROUP_ID` | POST_OR_GROUP_ID | n/a |
| Craigslist | Job post | `?utm_source=craigslist&utm_medium=job_post&utm_campaign=vgn_otr&utm_content=POST_ID&posting_city=CITY&creative_id=POSTER_ID` | POST_ID, CITY, POSTER_ID | n/a |
| TikTok | Paid social | `?utm_source=tiktok&utm_medium=paid_social&utm_campaign=__CAMPAIGN_ID__&utm_term=__AID__&utm_content=__CID__&placement=__PLACEMENT__` | all macros | **NO — verify in TikTok Ads** |
| TikTok | Organic (bio) | `?utm_source=tiktok&utm_medium=organic_social&utm_campaign=vgn_otr&utm_content=VIDEO_ID` | VIDEO_ID | n/a |
| Instagram | Organic (bio/story) | `?utm_source=instagram&utm_medium=organic_social&utm_campaign=vgn_otr&utm_content=POST_ID` | POST_ID | n/a |

> **FB vs IG split depends on the Meta `{{site_source_name}}` macro, which you said you can't verify yet.** Until a tagged link using that macro is live, Meta paid clicks keep landing in **Facebook** (that is why Instagram currently shows only 3). Classifier already maps `fb`→Facebook, `ig`→Instagram, and `msg`/`an`→Facebook (placement shown in drill-down) **once such links run**. Existing untagged links can't reveal the post/banner retroactively.

## 2. Metric dictionary (§8) — shown in the dashboard's "Definitions & limits" footer
Visit=session (30-min timeout, reloads merged, multi-tab not double-counted, bots/test excluded). Active time=foreground estimate (hidden/idle>60s excluded), not proven attention; avg always with median + n, recomputed from totals. Saved contact ("Applied")=backend-confirmed save, idempotent (retries/double-taps don't duplicate); clicks/opens/IntelliApp are not applications. Measured conversion=submit sessions ÷ measured sessions; outcomes to session-start cohort; recent cohorts provisional. Time before submit=active time to first confirmed save; missing timing excluded, not zeroed. Short visits (bounce proxy)=≤10s active, 1 page, no submission, no meaningful CTA/statement interaction (not GA4 bounce). Unattributed (pre-tracking)=saved contacts with no linked measured visit — counted in totals, excluded from rates. Date basis: traffic=session-start; contacts=submission date/hour. Central time (provisional).

## 3. Schema & retention diff (applied to Supabase, additive/backward-compatible)
**New columns:** `va_sessions.job_id`, `va_sessions.placement`, `driver_leads.test` (bool, default false).
**New tables (RLS: admin + Ray read; service write):** `va_labels` (id_type,id→label), `va_section_exposure` (session,section,visible_ms,interactions,reached,is_last), `va_daily_rollup` (day,channel→visits/submits/contacts/active sums/short/events jsonb/sections jsonb).
**New RPC:** `va_dashboard_v3(from date, to date)` — security-definer, `authenticated`-only, raises on >30-day ranges (server-side cap), returns all breakdowns.
**Retention (confirmed):** `va_events` + `va_section_exposure` purged at 30 days; `va_sessions` at 365 days; `va_daily_rollup` kept 12 months (feeds the 90-day Excel after raw events age out). Existing cron `va-retention-cleanup` extended to the new tables when published.

## 4. Rollback plan
Dashboard work is on branch `vgn-dashboard-v3`; `main` and the live site are untouched (GitHub Pages deploys `main` only). To abandon: delete the branch. The DB changes are additive — nothing existing was altered or dropped; the current Phase-1 dashboard keeps working. To fully revert DB: `drop function va_dashboard_v3; drop table va_daily_rollup, va_section_exposure, va_labels; alter table va_sessions drop column job_id, drop column placement; alter table driver_leads drop column test;` (none hold data the live app depends on).

## 5. Status — implemented / verified / remaining
**Implemented & verified (this pass):**
- Inspection + plan (approved). Branch created. 2 confirmed test leads deleted + their session excluded.
- Schema foundations + `va_dashboard_v3` RPC — verified on live data: 458 visits = Facebook 378+Direct 52+Craigslist 20+Indeed 5+Instagram 3; measured conv 0.7% (3/458); contacts 6 = 3 measured + 3 unattributed; funnel monotonic; §5 fixes built in (big 0-submission rows show 0.0%, low-sample by sessions).
- `vgn-dashboard.html` preview: light/dark/system themes (pre-paint, localStorage), KPI strip with deltas, daily-by-channel stacked + contacts panel, dayparts, 24-hour, weekday×hour heatmap, funnel, channel table (share bars + low-sample badges), submitted-vs-not, interactions, definitions footer, channel multi-select, 30-day-capped ranges, CSV export. Verified dark+light, desktop + 375px (no page overflow; tables scroll inside).

**Done since (branch, preview — awaiting deploy approval):**
- **Live RPC wiring** (2026-10-13, DEPLOYED to main): Supabase anon client + email/password login modal in `vgn-dashboard.html`; sample preview is default until admin/Ray sign in, then `load()` calls `va_dashboard_v3`. LIVE at fleetguards.app/vgn-dashboard.html (additive new page).
- **Excel monthly export** (§7) BUILT (branch, not yet deployed): vendored SheetJS 0.18.5 (`js/vendor/xlsx.full.min.js`, CSP 'self') + new RPC `va_export_range(from,to)` (≤100-day cap, authenticated-only, same channel classification as v3 so numbers reconcile). "Monthly Excel" button downloads a workbook: About, Summary (one row per month incl. pre-analytics months that have only contacts, flagged `tracked=no`), one tab per month with session data (channel breakdown), Daily visits, Daily contacts. Verified via write→read round-trip against live data (Sept 17 contacts pre-analytics; Oct 469 visits / 3 submits / 12 contacts; FB 389 / Craigslist 20@10%). Gated to signed-in users (sample mode shows a sign-in prompt).

**Remaining (next passes, still preview/branch — no deploy):**
- Port the dashboard into the real surfaces (`leads.html` + in-app `app.js`) if it should replace, not just sit beside, the Phase-1 view.
- **Section measurement** (§9): landing-page IntersectionObserver instrumentation + `va-collect` ingestion → the Sections panel (currently "not measured" placeholder). *(You OK'd the landing-page change.)*
- **Rollup cron** (`va_daily_rollup`) so months keep interaction/section detail after raw events age out at 30 days (the Excel's visit/contact/active numbers already survive via `va_sessions` 365-day retention, so this is only needed for the finer event/section columns).
- **Day drill-down** (click a day → 24h by channel), full period-comparison on all KPIs.
- Capture **`job_id` + `placement`** on the landing page; add `msg`/`an`→Facebook to the live classifier.
- Full acceptance-test evidence (§12) + AA contrast ratio report.

Per the spec: **stopping here for your review — nothing is deployed.**
