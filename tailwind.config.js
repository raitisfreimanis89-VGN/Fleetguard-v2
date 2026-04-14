/** @type {import('tailwindcss').Config} */
module.exports = {
  // ─── Dark mode ───────────────────────────────────────────────────────────────
  // Uses the "class" strategy: add/remove class="dark" on <html> via JS.
  // This matches the existing theme toggle behaviour exactly.
  darkMode: "class",

  // ─── Content paths ───────────────────────────────────────────────────────────
  // Tailwind scans these files to tree-shake unused utilities.
  // index.html is the single source of all class usage.
  // The app.js entry is listed too in case JS-generated class strings are added
  // later (e.g. dynamic badge/toast class names already exist in renderVehicles).
  content: [
    "./index.html",
    "./src/**/*.{js,ts}",
  ],

  theme: {
    extend: {
      // ── Custom color tokens ──────────────────────────────────────────────────
      // Extracted verbatim from the inline tailwind.config block in the CDN version.
      // These map to Tailwind utilities like bg-surface, text-primary-container, etc.
      // NOTE: the actual theming (dark/light switch) is done via CSS custom properties
      // (--c-surface, etc.) in the <style> block. These Tailwind tokens exist for any
      // utility classes used in markup (e.g. bg-surface-container, text-on-surface).
      colors: {
        // Surfaces
        "surface":                   "#10131a",
        "surface-container-lowest":  "#0b0e14",
        "surface-container-low":     "#191c22",
        "surface-container":         "#1d2026",
        "surface-container-high":    "#272a31",
        "surface-container-highest": "#32353c",
        "surface-variant":           "#32353c",

        // Brand / accent
        "primary":              "#ffb5a0",
        "primary-fixed":        "#ffdbd1",
        "primary-fixed-dim":    "#ffb5a0",
        "primary-container":    "#ff5722",
        "on-primary":           "#5f1500",
        "on-primary-container": "#541200",

        // Typography
        "on-surface":         "#e1e2eb",
        "on-surface-variant": "#e4beb4",
        "on-background":      "#e1e2eb",

        // Status — green
        "tertiary":           "#78dc77",
        "tertiary-container": "#41a447",
        "tertiary-fixed":     "#94f990",
        "on-tertiary":        "#00390a",

        // Secondary
        "secondary":           "#bbc8d0",
        "secondary-container": "#3c494f",

        // Error
        "error":              "#ffb4ab",
        "error-container":    "#93000a",
        "on-error-container": "#ffdad6",

        // Borders / outlines
        "outline":         "#ab8980",
        "outline-variant": "#5b4039",
      },

      // ── Custom font families ─────────────────────────────────────────────────
      // Matches font-headline / font-body / font-label utility classes.
      fontFamily: {
        headline: ["Manrope", "sans-serif"],
        body:     ["Inter", "sans-serif"],
        label:    ["Inter", "sans-serif"],
      },

      // ── Border radius scale ──────────────────────────────────────────────────
      borderRadius: {
        DEFAULT: "0.25rem",
        lg:      "0.5rem",
        xl:      "0.75rem",
        "2xl":   "1rem",
        full:    "9999px",
      },
    },
  },

  plugins: [],
};
