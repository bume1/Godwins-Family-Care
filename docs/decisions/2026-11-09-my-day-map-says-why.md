# My Day map says why a stop is missing

**Owner report, 2026-11-09:** "the map on the My Day page doesn't work, even when coordinates are added."

## What was actually wrong
The map itself worked. Rendered in Chromium with real `myDay` output, stops with coordinates plot and join correctly. The problem was the empty state: it had one sentence ("None of today's visits has address coordinates… set them under Scheduling → Locations") for four different causes:

1. no visits on the day,
2. the OpenEMR calendar could not be read,
3. every visit was a video visit,
4. the visit's OpenEMR patient is not linked to an app client (`openEmrPatientId`), so there is no client record to read coordinates from.
5. (follow-up, same day) two client records share the patient's name: Scheduling → Locations shows the one with coordinates, the visit points at the other. Reported as `other_record`.

So an admin who had set coordinates was told to set them again. Video visits were also counted as "no coordinates".

## What changed
- `myDay.plotStops` returns `unplaced` (name, time, `reason`: `not_linked` | `other_record` | `no_coordinates`); the route passes every client record so a same-name duplicate holding the coordinates can be named, `remote` and `total`. Video visits are no longer counted as unplaceable.
- `DayMap` takes the calendar status and says which of the four cases it is, and lists each unplotted stop with the fix that applies.
- SVG labels near the edge are no longer clipped.

## Must not undo
- An empty map never says "no coordinates" unless that is the reason.
- Still no map tiles (unchanged). A street map remains an owner decision.

Verified: new test in `test/clinical_workspace_412.test.js`; full suite 3582 pass, 0 fail; rendered in Chromium.
