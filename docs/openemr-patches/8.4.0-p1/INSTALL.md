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

**No new OAuth scope, so the v3 client does not need re-registering.** Standard
`/api/` routes on 8.4 are gated by an ACL check, not by a per-route scope, and
the server's API scope list is a hardcoded array in source. These routes use the
same ACL the Fee Sheet and diagnosis screens use, `encounters` / `coding_a`.

---

## How this is installed, and why it is done this way

OpenEMR runs from a Docker image: a sealed package of the application as its
makers published it. You cannot edit a sealed package, so the patch is applied
by **building a new image** from the official one plus our two files, tagged
`gfc/openemr:8.4.0-p1`.

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

```
sudo mkdir -p /opt/openemr/gfc-patch && cd /opt/openemr/gfc-patch
```

You need three files here. Pull them straight from the repo branch:

```
sudo curl -fsSL -o Dockerfile \
  https://raw.githubusercontent.com/bume1/Godwins-Family-Care/main/docs/openemr-patches/8.4.0-p1/Dockerfile
sudo mkdir -p src/RestControllers apis/routes
sudo curl -fsSL -o src/RestControllers/GfcChargeRestController.php \
  https://raw.githubusercontent.com/bume1/Godwins-Family-Care/main/docs/openemr-patches/8.4.0-p1/src/RestControllers/GfcChargeRestController.php
sudo curl -fsSL -o apis/routes/_rest_routes_standard.inc.php.patch \
  https://raw.githubusercontent.com/bume1/Godwins-Family-Care/main/docs/openemr-patches/8.4.0-p1/apis/routes/_rest_routes_standard.inc.php.patch
```

If the repo is private and curl returns 404, copy the three files across with
`scp` using the break-glass key, or paste them in with `sudo nano`.

Confirm all three arrived:

```
find /opt/openemr/gfc-patch -type f
```

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

The build takes two to five minutes. It **applies the patch and then
syntax-checks both files**, so if a future upstream image has moved the route
file, the build fails here rather than producing a broken EMR.

No schema upgrade runs this time. It is the same 8.4 code plus two files. Wait
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

**If the build fails**, that is the patch protecting you. It means a newer
OpenEMR has rearranged the route file and our change no longer fits where it
expects to go. Nothing has been deployed at that point. Bring it to the app team
to regenerate the diff. Do not force it, and do not work around it by copying the
whole file over the new one — that would silently discard whatever upstream
changed.

**The permanent exit.** Once this patch has run clean for a month, offer it to
the OpenEMR project (Appendix D). These are gaps other practices hit too. If it
is accepted upstream, it ships in the official image and this whole section goes
away.

---

## Acceptance (Phase 6B, run by the app team with the app's token)

- A charge POSTed to a TEST encounter appears in **Fees → Billing Manager** with
  the right code, modifier, provider, and diagnosis pointers.
- An order POSTed appears under the patient's procedures with its order codes.
- A non-clinical token gets 401/403 on all of the above.

Screenshots and raw responses go into `docs/OPENEMR_SERVER_DEFECTS_2026-08.md`
as the closing entry for Gap 1.
