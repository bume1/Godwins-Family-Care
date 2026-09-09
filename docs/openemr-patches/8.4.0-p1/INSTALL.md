# Installing the GFC bounded patch on OpenEMR 8.4.0

Master Setup Guide v4, **Phase 6B**. Run this on the live EC2 box after Phase 6A
(the 8.4 upgrade) is done and verified. About 15 minutes, most of it the build.

Everything below is typed in the browser terminal: **EC2 → Instances →
gfc-openemr → Connect → EC2 Instance Connect**. Nothing touches your Mac.

---

## What this adds

Three things OpenEMR's own screens can do but its REST API cannot:

| Route | What it does |
|---|---|
| `POST /api/patient/{pid}/encounter/{eid}/billing` | Writes a fee-sheet charge line (CPT/HCPCS, modifier, units, fee, ICD-10 pointers, rendering provider). **This is what makes the app's sign-and-close land in Billing Manager.** |
| `POST /api/patient/{pid}/encounter/{eid}/order` | Creates a procedure order plus its order-code rows and files it on the encounter |
| `GET /api/codes?type=ICD10&search=…` | Searches the loaded code tables — retires the app's last coding workaround |

Plus the reads and the status update that go with them: `GET …/billing`,
`DELETE …/billing/{id}` (voids, never hard-deletes), `GET …/order`,
`PUT …/order/{orderId}`.

### These routes need new OAuth scopes, and therefore a new client

An earlier version of this file said no new scope was needed. **That was wrong**,
and it cost an install cycle. The correction:

OpenEMR's standard API derives the required scope **from the route path**.
`HttpRestRouteHandler::checkSecurity()` takes the resource from the last path
segment and the permission from the HTTP method, so
`POST .../encounter/{eid}/billing` demands `user/billing.c`. That is why the
app's note writes work (it holds `user/soap_note.write`) and why these routes
returned 401 "Unauthorized" — refused at the scope layer, before the ACL check
ever ran. An ACL failure reads "Organization policy does not have permit access
resource"; the wording is how you tell the two apart.

The server confirms it directly: registering a client with `user/billing.read`
is rejected with `invalid_scope … Check the user/billing.read scope`.

So the build registers five scopes (step 4): `user/billing.read/.write`,
`user/order.read/.write`, `user/codes.read`. `write` covers create, update and
delete; `read` covers read and search.

**Because scopes bind at registration, a new OAuth client is required** — the v3
client cannot be widened. The app team registers it after this build; an
administrator enables it under Administration → System → API Clients.

The routes are *additionally* ACL-gated on `encounters` / `coding_a`, the same
permission the Superbill and Encounters Report use, so a token that cannot code
an encounter in the UI cannot code one through the API either.

---

## How this is installed, and why it is done this way

OpenEMR runs from a Docker image: a sealed package of the application as its
makers published it. You cannot edit a sealed package, so the patch is applied
by **building a new image** from the official one plus our four files, tagged
`gfc/openemr:8.4.0-p1`.

The patch is **not a diff**, and needs no `patch` tool. OpenEMR's route map is a
PHP file that returns an array. The build renames that file aside, keeping it
byte-for-byte, and drops in a small wrapper that includes it and merges our
routes on top. Upstream can rewrite the contents of its route map however it
likes and our routes still load, because nothing of theirs is edited. A diff
would have gone stale the first time upstream touched that file for any
unrelated reason.

The build is wired into `docker-compose.yml` itself rather than run as a
separate step. That matters for one specific reason:

> **After this install, the name `openemr/openemr:8.4.0` no longer appears
> anywhere in the compose file.** There is therefore no command — including a
> habitual `docker compose pull` — that can quietly put the stock image back and
> take the patch with it. The worst a stray pull can do is nothing.

The alternative (build by hand, then point the compose file at the result) works
too, but it leaves the stock image name in the file and depends on somebody
remembering an extra step every month. This way the normal command is the
correct command.

---

## Step 1 — Put the patch files on the server

Five files. Pull them straight from the repo:

```
sudo mkdir -p /opt/openemr/gfc-patch/src/RestControllers /opt/openemr/gfc-patch/apis/routes
cd /opt/openemr/gfc-patch
B=https://raw.githubusercontent.com/bume1/Godwins-Family-Care/main/docs/openemr-patches/8.4.0-p1
sudo curl -fsSL -o Dockerfile "$B/Dockerfile"
sudo curl -fsSL -o src/RestControllers/GfcChargeRestController.php "$B/src/RestControllers/GfcChargeRestController.php"
sudo curl -fsSL -o apis/routes/_rest_routes_standard.inc.php "$B/apis/routes/_rest_routes_standard.inc.php"
sudo curl -fsSL -o apis/routes/_rest_routes_gfc.inc.php "$B/apis/routes/_rest_routes_gfc.inc.php"
sudo curl -fsSL -o gfc-add-scopes.php "$B/gfc-add-scopes.php"
```

If the repo has been made private, `curl` needs a token: add
`-H "Authorization: Bearer $GH"` to each line and fetch from
`https://api.github.com/repos/bume1/Godwins-Family-Care/contents/docs/openemr-patches/8.4.0-p1/<path>`
with `-H "Accept: application/vnd.github.raw"`.

Then verify the files are exactly what was published:

```
cd /opt/openemr/gfc-patch && sha256sum -c <<'SUMS'
70bf5e1a1eaf323986187a1fa634a1a1a95ad486666669adf23d531023a339c1  Dockerfile
cb5b3f4746c228e07c86d5ea6dbfa2d034b8bbeef7962c0564f52d372339eb40  apis/routes/_rest_routes_standard.inc.php
a3515a22b7d6a4cea94884045c2a141a634a59979535d8447ae551bc35e3ec11  apis/routes/_rest_routes_gfc.inc.php
0333542b8c9e054711f50f7b31dbe9cec40c70f3479698b0ac31a8eb95a76d66  gfc-add-scopes.php
4310e14f6cd63b2d954afbf4ec616b427e2412511483213e096aa006de8ae317  src/RestControllers/GfcChargeRestController.php
SUMS
```

Five `OK` lines means the files are intact. Anything else, stop.

## Step 2 — Back up the compose file

One line, and it is what you restore from if anything below goes sideways:

```
cd /opt/openemr && sudo cp docker-compose.yml docker-compose.yml.pre-6b
```

## Step 3 — Point compose at the build instead of the stock image

Open the file:

```
sudo nano /opt/openemr/docker-compose.yml
```

Find the line that currently reads:

```yaml
    image: openemr/openemr:8.4.0
```

Replace that **one line** with these four (keep the same indentation — two
spaces before `build:`, four before `context:`):

```yaml
    build:
      context: /opt/openemr/gfc-patch
    image: gfc/openemr:8.4.0-p1
```

Change nothing else. The RDS endpoint, the passwords, the volumes, and the
`DOMAIN` line all stay exactly as they are.

Save with Ctrl+O, Enter, then Ctrl+X. Check it:

```
cd /opt/openemr && sudo docker compose config | grep -A3 -E "build:|image:"
```

## Step 4 — Build and start

```
cd /opt/openemr && sudo docker compose up -d --build && sudo docker compose logs -f
```

The build takes two to five minutes. It **checks that OpenEMR's route map is
where we expect, refuses to build on an already-patched base, registers the
scopes the routes need, and syntax-checks all five files** (ours plus the
preserved upstream map plus the scope list). If any of that fails the
build stops, and nothing is deployed.

No schema upgrade runs this time. It is the same 8.4 code plus four files. Wait
for Apache to settle, then Ctrl+C.

## Step 5 — Confirm it is live

```
curl -sS -o /dev/null -w '%{http_code}\n' https://emr.godwinsfamilycarellc.com/apis/default/api/codes
```

**`401` is the right answer.** It means the route exists and is asking for a
token you did not send. A `404` means the patch did not take, so check step 3.

Then tell the app team, who run the acceptance probes with the app's token.

---

## Rollback

Nothing in the database changed, and the stock image is still on the box:

```
cd /opt/openemr && sudo cp docker-compose.yml.pre-6b docker-compose.yml && sudo docker compose up -d
```

Back on stock 8.4 in under a minute.

---

## The monthly routine (control C-10) — what changes

**The compose file is edited once, at install, and never again.** There is no
monthly hand-editing of anything.

Your guide's monthly maintenance already has you pulling the latest image. That
command changes by one word, and the new one does the whole job: fetch the
newest official base, re-apply our patch on top, restart, and report whether the
patch survived.

Was:

```
cd /opt/openemr && sudo docker compose pull && sudo docker compose up -d
```

Now, one paste, and it tells you the answer in words:

```
cd /opt/openemr && sudo docker compose build --pull && sudo docker compose up -d && sleep 25 && case $(curl -sS -o /dev/null -w '%{http_code}' https://emr.godwinsfamilycarellc.com/apis/default/api/codes) in \
  401) echo "PATCH OK — charge writes are live" ;; \
  404) echo "PATCH MISSING — do not bill from the app until this is fixed" ;; \
  *)   echo "UNEXPECTED — check the EMR before billing" ;; \
esac
```

Same effort as the command it replaces. Nothing to remember beyond using this
line instead of the old one, which is why it belongs in the monthly checklist
verbatim rather than as a note to "also rebuild."

**If the build fails**, that is the patch protecting you. Because this wraps
OpenEMR's route map rather than editing it, an ordinary upstream change to that
file will not trip it. A failure means something structural: the route map was
renamed or removed, or OpenEMR changed how it loads routes. Nothing has been
deployed at that point. Bring it to the app team. Do not force it, and do not
work around it by copying files over the new ones, which would silently discard
whatever upstream changed.

**The permanent exit.** Once this patch has run clean for a month, offer it to
the OpenEMR project (Appendix D). These are gaps other practices hit too. If it
is accepted upstream, it ships in the official image and this whole section goes
away.

---

## Update 2026-09-08 — code search rewritten, needs one rebuild

`GET /api/codes` was returning an empty list for every ICD-10 term even though
the ICD-10-CM set had been loaded. The route ran its own
`FROM codes c JOIN code_types ct` query, which reads the **manually entered
`codes` table only**. OpenEMR's External Data Loads writes ICD-10 into a
separate external table (`icd10_dx_order_code`), so that query could never see
a loaded code set — it returned zero rows whether or not the load had run, and
the empty result was read as "the load has not run" when in fact it had.

`searchCodes()` now calls OpenEMR's own `main_code_set_search()`, which is the
function the Fee Sheet itself calls (`interface/forms/fee_sheet/new.php`). Every
external code set works as a result, and the query keeps working when upstream
changes the table layout.

**RE-FETCH THE FILE FIRST, THEN REBUILD. A rebuild alone does nothing.**

This was written as "it needs a rebuild", which is wrong and cost a cycle on
2026-09-09: the build copies `/opt/openemr/gfc-patch/` into the image, and that
directory holds the copy fetched in step 1 — the OLD controller. Rebuilding
without re-fetching rebuilds the old code, succeeds, and changes nothing.

```
cd /opt/openemr/gfc-patch
B=https://raw.githubusercontent.com/bume1/Godwins-Family-Care/main/docs/openemr-patches/8.4.0-p1
sudo curl -fsSL -o src/RestControllers/GfcChargeRestController.php "$B/src/RestControllers/GfcChargeRestController.php"
sha256sum src/RestControllers/GfcChargeRestController.php
#   expect 4310e14f6cd63b2d954afbf4ec616b427e2412511483213e096aa006de8ae317
cd /opt/openemr && sudo docker compose build --pull && sudo docker compose up -d
```

Only the controller changed; the other four files are unchanged.

**Tell the two versions apart without a code set.** Ask for a code type that does
not exist:

```
curl -sS -H "Authorization: Bearer $TOKEN" \
  'https://emr.godwinsfamilycarellc.com/apis/default/api/codes?search=E11&type=ZZBOGUS'
```

The OLD controller answers `"data":[]` with no validation error — it appends the
type to a WHERE clause and matches nothing. The NEW one answers a
`validationErrors` message naming the active code types. That distinction holds
whether or not any code set is loaded, which matters because "0 rows" is exactly
the signal that has already been misread once here.

Then confirm the route now returns real rows, with the app's token:

```
OPENEMR_CLIENT_ID=… OPENEMR_CLIENT_SECRET=… OPENEMR_API_USERNAME=… OPENEMR_API_PASSWORD=… \
  node scripts/verify_84_transport.js
```

A direct check of the fix itself: search `E11` with `type=ICD10` and expect
E11.9 "Type 2 diabetes mellitus without complications" in the results. Before
the rebuild that search returns nothing; after it, rows. **Assert on the rows,
not on the 200** — the old route also answered 200.

Nothing else changes: no schema, no scopes, no new files. Rollback is the same
step-3 restore as before.

---

## Acceptance — ✅ passed 2026-09-06, 17/17

`acceptance.js` in this directory is the test. It proves the three routes end to
end against the live instance:

```
OPENEMR_BASE_URL=https://emr.godwinsfamilycarellc.com \
OPENEMR_CLIENT_ID=… OPENEMR_CLIENT_SECRET=… \
OPENEMR_API_USERNAME=… OPENEMR_API_PASSWORD=… \
node acceptance.js
```

Credentials come from the environment; nothing is read from a file. **TEST DATA
only** — it writes a charge and an order to the TEST patient's encounter.

It asserts **stored values, not status codes**, and that is the point. Every
defect it caught returned `201` and looked correct in Billing Manager: a charge
storing the wrong code, or diagnosis pointers reading `ICD10|Array:`, surfaces as
a denial weeks later rather than as an error at write time. A status-code test
would have passed all three runs.

Results and the two controller defects it found are the closing entry for Gap 1
in `docs/OPENEMR_SERVER_DEFECTS_2026-08.md`.
