# FleetGuard v2 — Safety & Compliance

Fleet management app for tracking vehicles, drivers, brake tests, tyre checks, DOT inspections, and mileage. Works offline with localStorage, or connects to Supabase for shared team data.

## Project structure

```
fleetguard-v2/
├── index.html                  # App shell + HTML structure
├── css/
│   └── styles.css              # All styles
├── js/
│   └── app.js                  # All application logic
└── .github/
    └── workflows/
        └── deploy.yml          # Auto-deploy to GitHub Pages
```


## Features

- **Dashboard** — fleet health overview, overdue alerts, recent activity
- **Vehicles** — add/delete vehicles, view per-vehicle detail tabs
- **Drivers** — add/edit/delete drivers
- **Calendar** — upcoming brake tests and inspection due dates
- **Reports** — fleet-wide charts and per-vehicle summary table
- **Driver Portal** — simplified form for drivers to submit tyre checks and mileage

## Running locally

Just open `index.html` in a browser — no build step needed.

## Deploying to GitHub Pages

1. Push to `main` or `master` branch
2. In your repo: **Settings → Pages → Source → GitHub Actions**
3. The `deploy.yml` workflow will deploy automatically on every push

## Connecting Supabase (optional)

By default the app stores data in `localStorage` (single browser only).

To share data across users:
1. Create a free project at [supabase.com](https://supabase.com)
2. Run the SQL setup script (shown inside the app under ⚙ Database)
3. Click **⚙ Database** in the app and enter your Project URL + anon key

## Compliance rules enforced

| Check | Schedule |
|-------|----------|
| Brake inspection | Every 42 days |
| Tyre photo check | Every 14 days |
| DOT inspection | Logged manually |
| "Vicious circle" alert | Service record without same-day brake test |
