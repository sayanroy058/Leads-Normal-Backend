# GradLeadAI — External REST API (v1)

A REST API for external systems to **read and update leads** in your GradLeadAI
workspace. It is the integration point for automated tools such as the **AI
calling agent (Plivo)** — after a call, the agent calls this API to save what it
learned (e.g. *"2 BHK Flat in Newtown, Kolkata"*), and the change appears on the
dashboard immediately.

Every request is scoped to the owner of the API key: a key can only ever see and
modify that account's leads. There is no cross-tenant access.

---

## Base URL

```
https://leads-normal-backend-two.vercel.app/api/v1
```

(For local development: `http://localhost:3001/api/v1`.)

---

## Authentication

All endpoints require an API key. Send it either header:

| Header | Value |
|---|---|
| `X-API-Key` | `gld_<48 hex chars>` |
| `Authorization` | `Bearer gld_<48 hex chars>` |

Example:

```bash
curl https://leads-normal-backend-two.vercel.app/api/v1/leads \
  -H "X-API-Key: gld_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f"
```

### Creating a key

1. Sign in to the dashboard.
2. Open **API Keys** in the sidebar.
3. Click **New key**, give it a name (e.g. *"Plivo calling agent"*), and copy it.
4. The full key is **shown only once** — only a hash is stored server-side.

Revoke a key any time from the same page; revoked keys stop working instantly.

### Errors

Errors use the shape `{ "error": "...", "message": "..." }`:

| Status | Meaning |
|---|---|
| `400` | Bad request — the JSON body failed validation (see `message`). |
| `401` | Missing, invalid, or revoked API key. |
| `404` | The lead id doesn't exist for this account. |

---

## The Lead object

Almost every endpoint returns a lead (or a list of them):

```json
{
  "id": "32705d13-3661-40fb-8ddd-6ce1cbe9c2d6",
  "name": "Sayan Roy",
  "email": "sayan@example.com",
  "phone": "+91 90629 86383",
  "company": null,
  "city": "Kolkata",
  "source": "api",
  "status": "new",
  "score": 50,
  "value": null,
  "notes": "Flat in NewTown",
  "interest": "buying",
  "category": null,
  "region": "West Bengal",
  "urgency": null,
  "budget_min": null,
  "budget_max": null,
  "last_activity": "2026-10-10T08:12:00.000Z",
  "created_at": "2026-10-10T07:52:04.788Z",
  "requirements": [
    { "label": "Property", "value": "2 BHK Flat in Newtown, Kolkata" },
    { "label": "Budget",   "value": "60L - 80L" },
    { "label": "Handover", "value": "Within 6 months" }
  ]
}
```

**`requirements`** is an ordered list of free-form `{ label, value }` pairs. It
is intentionally industry-neutral — use any labels you like (`Property`,
`Budget`, `Handover`, `Location`, `Possession`, `Configuration`, `Loan`, …).
Both sides of a pair may be empty-string but not both.

**`status`** is one of: `new`, `contacted`, `qualified`, `meeting`, `proposal`,
`closed`, `lost`.

**`score`** is 0–100 and is computed automatically from how many lead fields are
filled in — you do not set it.

> **Lead id:** endpoints that take `:id` accept either the full UUID **or just
> the first 8 characters** (the short form shown in the UI).

---

## Endpoints

### 1. `GET /me` — verify the key

Confirms the key works and tells you which account it belongs to.

```bash
curl https://<base>/me -H "X-API-Key: gld_..."
```

```json
{
  "key":  { "id": "9f2c...", "name": "Plivo calling agent" },
  "user": { "id": 9, "name": "Sayan Roy", "email": "sayanroy058@gmail.com" }
}
```

---

### 2. `GET /leads` — list leads

| Query param | Type | Description |
|---|---|---|
| `query` | string | Case-insensitive match on name, email, phone, company or city. |
| `status` | string | Filter by pipeline stage. |
| `limit` | number | Max rows (default `50`, max `200`). |

```bash
curl "https://<base>/leads?query=2%20BHK&limit=10" -H "X-API-Key: gld_..."
```

**Response** `200` — array of Lead objects, most recently active first.

---

### 3. `POST /leads` — create a lead

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **yes** | 1–200 chars. |
| `email` | string\|null | no | Must be a valid email. |
| `phone` | string\|null | no | Store in E.164 where possible, e.g. `+91 90629 86383`. |
| `company`, `city`, `source`, `notes` | string\|null | no | |
| `status` | string | no | Defaults to `new`. |
| `interest`, `category`, `region`, `urgency` | string\|null | no | |
| `value`, `budget_min`, `budget_max` | number\|null | no | |
| `requirements` | array | no | List of `{ label, value }`. |

```bash
curl -X POST https://<base>/leads \
  -H "X-API-Key: gld_..." -H "Content-Type: application/json" \
  -d '{
    "name": "xyz",
    "email": "xyz@example.com",
    "phone": "+91 90629 86383",
    "city": "Kolkata",
    "source": "inbound-call",
    "requirements": [
      { "label": "Property", "value": "2 BHK Flat in Newtown, Kolkata" },
      { "label": "Budget",   "value": "60L - 80L" }
    ]
  }'
```

**Response** `201` — the created Lead.

---

### 4. `GET /leads/:id` — get one lead

```bash
curl https://<base>/leads/32705d13 -H "X-API-Key: gld_..."
```

**Response** `200` — the Lead. `404` if not found.

---

### 5. `PATCH /leads/:id` — update lead fields

Updates only the fields you send (partial update). Send any subset of the fields
listed for `POST /leads`, **including `requirements`** to replace the whole list.
`last_activity` and `score` are refreshed automatically.

```bash
curl -X PATCH https://<base>/leads/32705d13 \
  -H "X-API-Key: gld_..." -H "Content-Type: application/json" \
  -d '{ "status": "qualified", "notes": "Wants a Newtown flat, ready to move" }'
```

**Response** `200` — the updated Lead. `400` if no updatable fields are sent.

---

### 6. `PUT /leads/:id/requirements` — replace all requirements

Best when the agent has the **complete** requirement set after a call.

**Body**

```json
{ "requirements": [ { "label": "Property", "value": "2 BHK Flat in Newtown, Kolkata" } ] }
```

```bash
curl -X PUT https://<base>/leads/32705d13/requirements \
  -H "X-API-Key: gld_..." -H "Content-Type: application/json" \
  -d '{"requirements":[{"label":"Property","value":"2 BHK Flat in Newtown, Kolkata"},{"label":"Budget","value":"60L - 80L"},{"label":"Handover","value":"Within 6 months"}]}'
```

**Response** `200` — the updated Lead. Send `{"requirements":[]}` to clear them.

---

### 7. `POST /leads/:id/requirements` — add or update one requirement

The most convenient tool for an agent: records a single detail as it is learned.
If a requirement with the same label already exists (case-insensitive), it is
updated; otherwise it is appended.

**Body**

| Field | Type | Required |
|---|---|---|
| `label` | string | **yes** (1–80 chars) |
| `value` | string | no (≤1000 chars) |

```bash
curl -X POST https://<base>/leads/32705d13/requirements \
  -H "X-API-Key: gld_..." -H "Content-Type: application/json" \
  -d '{"label":"Property","value":"2 BHK Flat in Newtown, Kolkata"}'
```

**Response** `200` — the updated Lead.

---

### 8. `DELETE /leads/:id/requirements/:label` — remove one requirement

Removes the requirement whose label matches (case-insensitive). URL-encode the
label (spaces as `%20`).

```bash
curl -X DELETE "https://<base>/leads/32705d13/requirements/Handover" \
  -H "X-API-Key: gld_..."
```

**Response** `200` — the updated Lead (no-op if the label isn't present).

---

## Common workflow — AI calling agent

After a call, the agent resolves the lead and writes back what it learned:

```bash
LEAD=32705d13   # full id or 8-char prefix

# Optional: confirm the lead
curl https://<base>/leads/$LEAD -H "X-API-Key: gld_..."

# Record each requirement as it is confirmed
curl -X POST https://<base>/leads/$LEAD/requirements \
  -H "X-API-Key: gld_..." -H "Content-Type: application/json" \
  -d '{"label":"Property","value":"2 BHK Flat in Newtown, Kolkata"}'

curl -X POST https://<base>/leads/$LEAD/requirements \
  -H "X-API-Key: gld_..." -H "Content-Type: application/json" \
  -d '{"label":"Budget","value":"60L - 80L"}'

curl -X POST https://<base>/leads/$LEAD/requirements \
  -H "X-API-Key: gld_..." -H "Content-Type: application/json" \
  -d '{"label":"Handover","value":"Within 6 months"}'

# Move the lead forward
curl -X PATCH https://<base>/leads/$LEAD \
  -H "X-API-Key: gld_..." -H "Content-Type: application/json" \
  -d '{"status":"qualified"}'
```

All of these show up on the dashboard's lead page (and in the leads list) right
away.

---

## Notes & limits

- Content type is always `application/json`.
- Max 50 requirement items per lead; labels ≤ 80 chars, values ≤ 1000 chars.
- `last_activity` is bumped on every write, so updated leads sort to the top.
- Keys are per-account. Create separate keys per integration so you can revoke
  one without affecting the others.
- This API has no rate limiting today; add client-side backoff for bulk work.
