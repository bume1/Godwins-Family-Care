# Installing the GFC bounded patch on OpenEMR 8.4.0

Master Setup Guide v4, **Phase 6B**. Run this on the live EC2 box after Phase 6A
(the 8.4 upgrade) is done and verified. About 15 minutes, most of it the image
build.

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

## Step 1 — Put the patch files on the server

From the browser terminal:

```
sudo mkdir -p /opt/openemr/gfc-patch && cd /opt/openemr/gfc-patch
```

You need three files here: `Dockerfile`, `apply.sh`, and the two patch payloads.
The simplest way is to pull them straight from the repo branch:

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
`scp` using the break-glass key instead, or paste them with `sudo nano`.

Check you have all three:

```
find /opt/openemr/gfc-patch -type f
```

## Step 2 — Build the patched image

```
cd /opt/openemr/gfc-patch
sudo docker build -t gfc/openemr:8.4.0-p1 .
```

Two to five minutes. The build **runs the patch and then syntax-checks both
files**, so if a future upstream image has moved the route file, the build fails
here rather than producing a broken EMR. A failure at the `patch` line means the
upstream file changed: stop and regenerate the diff, do not force it.

## Step 3 — Point compose at the patched image

One line, same as the 8.4 tag change:

```
cd /opt/openemr && sudo sed -i 's#image: openemr/openemr:8.4.0#image: gfc/openemr:8.4.0-p1#' docker-compose.yml && grep image docker-compose.yml
```

The output must read `image: gfc/openemr:8.4.0-p1`.

## Step 4 — Restart

```
cd /opt/openemr && sudo docker compose up -d && sudo docker compose logs -f
```

No schema upgrade runs this time — it is the same 8.4 code plus two files. Wait
for Apache to settle, then Ctrl+C.

## Step 5 — Confirm it is live

```
curl -sS -o /dev/null -w '%{http_code}\n' https://emr.godwinsfamilycarellc.com/apis/default/api/version
```

A `401` is the right answer here (the route exists, you sent no token). Then tell
the app team, who run the acceptance probes with the app's token.

---

## Rollback

Nothing was changed in the database and the original image is still on the box:

```
cd /opt/openemr && sudo sed -i 's#image: gfc/openemr:8.4.0-p1#image: openemr/openemr:8.4.0#' docker-compose.yml && sudo docker compose up -d
```

You are back on stock 8.4 in under a minute.

---

## Every month, after `docker compose pull` (control C-10)

A plain pull replaces the running image and **silently drops this patch**. The
monthly routine is therefore:

1. `cd /opt/openemr/gfc-patch && sudo docker build -t gfc/openemr:8.4.0-p1 .`
   (re-applies the patch on top of the newly pulled base)
2. `cd /opt/openemr && sudo docker compose up -d`
3. Re-run the acceptance test below.

If the build fails at the `patch` step after an upstream update, that is the
patch telling you the route file moved. Regenerate the diff before shipping.

---

## Acceptance (Phase 6B, run by the app team with the app's token)

- A charge POSTed to a TEST encounter appears in **Fees → Billing Manager** with
  the right code, modifier, provider, and diagnosis pointers.
- An order POSTed appears under the patient's procedures with its order codes.
- A non-clinical token gets 401/403 on all of the above.

Screenshots and raw responses go into `docs/OPENEMR_SERVER_DEFECTS_2026-08.md`
as the closing entry for Gap 1.
