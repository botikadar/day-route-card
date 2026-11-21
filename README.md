# Day Route Card

A Home Assistant dashboard card that shows **where a person was on a chosen day**: the route on a map,
the places they stopped, how they travelled between them, and a time slider.

It reads the location history Home Assistant already records for a phone's `device_tracker`, so there's
nothing extra to collect. You can only look back as far as your recorder keeps history (`purge_keep_days`).

## Features
- **Pick a person and a day.** ◀ / ▶ step through days, **Today** jumps back.
- **Route colored by travel mode:** vehicle, on foot, bike, or unclear. The mode comes from the phone's activity
  sensor (iOS *Activity*, Android *Detected activity*) when configured, or else from speed
  (under 7 km/h on foot, 25 km/h and over vehicle).
- **Stops** (by default 10+ minutes within 120 m) are numbered on the map and listed with their times and
  duration. The **trips** between stops show mode, distance and duration.
- **Place names:** stops inside a zone use the zone's name. Other stops get an approximate name
  ("≈ Lidl (supermarket)"), the nearest named place from Photon (OpenStreetMap), with Esri as a fallback.
  - **Correct it:** click a name to choose from up to 5 nearby places, or type your own. Your choices are saved
    in your Home Assistant user profile, so they sync across your devices, and they're reused for any stop within 75 m ("✓ name").
- **Click a stop** to zoom to it and move the time slider to when it started.
- **Time slider** moves a marker along the route.
- Zones are drawn on the map. A summary line shows the distance travelled.

## Install
1. Copy `day-route-card.js` to `config/www/`.
2. **Settings → Dashboards → ⋮ → Resources → Add resource**: URL `/local/day-route-card.js?v=1`, type
   *JavaScript module*. Bump `?v=` after updating the file.
3. Add the card. It works best in a **panel** view.

## Configuration
```yaml
type: custom:day-route-card
people:
  - name: Alex
    entity: device_tracker.alex_phone          # GPS tracker (phone app)
    color: "#3b82f6"
    activity: sensor.alex_phone_activity        # optional, iOS "Activity" or Android "Detected activity"
  - name: Sam
    entity: device_tracker.sam_phone
    color: "#e11d48"
zones: [zone.home, zone.work]                   # optional, default: all zones
max_accuracy: 150      # ignore GPS points less accurate than this (m)
stop_minutes: 10       # minimum stay to count as a stop
stop_radius: 120       # m
place_names: true      # look up names for stops outside zones
tile_url: https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}  # optional
```

## Privacy and external services
- The map library is **Leaflet 1.9.4** from cdnjs. Map tiles come from **Esri World Street Map** by default, which
  needs no key. CARTO now requires an API key, and OpenStreetMap's tile server refuses requests from Home Assistant
  pages, which send no Referer header.
- With `place_names: true`, only the **coordinates** of stops outside zones are sent to Photon (photon.komoot.io)
  and Esri to find nearby places. No name, person or time is sent. Results are cached in the browser.
  Set `place_names: false` to turn this off.
- Everything else stays in Home Assistant. Location history is read through the `history/history_during_period`
  websocket API.

## Limits
- History only covers what the recorder keeps (often 7–10 days).
- A phone indoors is often 20–50 m off, so "≈" names are a best guess. That's why you can correct them.
- Car and bus look the same ("vehicle").
