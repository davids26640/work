# HVAC Tracker

Keeps track of the plant's ash houses, air handlers, rooftop units and heaters: filter and belt sizes, filter and belt stock, what to order, cooling capacity, data plates and notes.

## Who sees what
- **Anyone who opens the site** sees the view-only version: no filter or belt change dates, no due dates, no daily notes log, and no editing.
- **The two approved users** sign in with **Sign in** (top right) and see everything: change dates, due and overdue status, the daily notes log, editing, and the **Today's notes** tab.

Data lives in a Supabase database. Row-level security keeps the full version readable only by the approved accounts. The public version is made automatically by the database, with dates and logs stripped out, every time an approved user saves.

## Today's notes
Write the unit name on its own line, then the notes for it on the lines below, and leave a blank line before the next unit:

```
RTU 08
Replaced supply fan belt

Ash 12
Needs pleats
```

The preview shows which unit each note will go to before you press **Add to units**.

## Files
- `index.html`: page layout
- `styles.css`: look and colors
- `app.js`: code
- `config.js`: database address and public (publishable) key
- `data.js`: offline backup of the public version, used only if the database can't be reached. It never contains change dates.
