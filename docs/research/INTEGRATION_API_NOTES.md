> Source-verified API notes behind Haley's SyncroMSP, Dynamics 365, Duo, Okta and Twilio integrations (compiled September 2026). Items marked UNVERIFIED weren't confirmed in official docs; the adapters handle them defensively and they are worth re-checking against a live account.

# API specs (source-verified 2026-09-27)

Legend: **UNVERIFIED** = not found stated in official docs; treat as assumption and test.

---

## 1. SyncroMSP REST API

Sources:
- OpenAPI 3.0 spec (authoritative, downloaded): https://api-docs.syncromsp.com/swagger.json (UI: https://api-docs.syncromsp.com/)
- Help doc: https://docs.syncrosecure.com/scripting-apis/syncro-rest-api (docs.syncromsp.com / help.syncromsp.com now 301 -> docs.syncrosecure.com)

### Base URL
```
https://{subdomain}.syncromsp.com/api/v1
```
(spec `servers[0].url`, variable `subdomain`).

### Auth
Spec `securitySchemes`:
```json
"apiKey":     { "type": "apiKey", "name": "api_key", "in": "query" },
"bearerAuth": { "type": "http",   "scheme": "bearer" }
```
Every ticket/customer/contact operation lists `security: [{ bearerAuth: [] }]`. So both work:
```
Authorization: Bearer <API_TOKEN>        // preferred (per spec) - keeps key out of URLs/logs
GET .../api/v1/tickets?api_key=<API_TOKEN>&page=2   // help doc: "?api_key= must come before any other parameters"
```
- Bare `Authorization: <token>` (no "Bearer") is commonly used in the wild: **UNVERIFIED**, use `Bearer`.
- Token: Admin > API - API Tokens > +New Token > Custom Permissions; check permission boxes; optional expiry. Key shown once. Token is tied to its permission set (named permissions below).

### Rate limit
"180 requests per minute per IP address" (spec `info.description` + help doc). No 429 response or rate-limit headers are documented in the spec -> handle HTTP 429 + back off (**UNVERIFIED** status code / `Retry-After`).

### Pagination
- Query `page` (1-based). Response `meta`:
  - tickets: `{"total_pages":1,"page":1}` (spec: "each 'page' contains 25 results"; no `per_page` param on /tickets)
  - customers: `{"total_pages":1,"total_entries":1,"per_page":100,"page":1}` (param doc says 25/page, example says per_page 100 -> read `meta`, don't hardcode)
  - contacts: `{"total_pages":1,"total_entries":1,"per_page":50,"page":1}` (param doc says 25)
  - `/tickets/{id}/comments`: `page`, `per_page` (default 10); meta `{total_pages,page,per_page}`
  - `/ticket_comments`: `page`, `per_page` (default 25, max 100)
- Loop: `for (page=1; page<=meta.total_pages; page++)`.

### Errors (documented)
- 401 `{"error":"Not authorized. Please ask account admin to update your group permissions."}`
- 404 (Invalid request / `{"message":"Not found"}`)
- 422 `{"success":false,"message":["Body can't be blank","Subject can't be blank"]}` or `{"error":"Customer required field"}` (shape varies: `message: string[]` or `error: string`)
- 403 for `parent_id` without permission.

### Tickets

#### List: `GET /tickets`  (perm: "Tickets - List/Search")
Query params (exact names from spec):
| param | notes |
|---|---|
| `since_updated_at` | "Returns Tickets updated after the date. Example "2019-02-25"" (format date-time; ISO 8601 accepted) |
| `created_after`, `resolved_after` | dates |
| `status` | "New", "In Progress", "Resolved", "Invoiced", "Waiting for Parts", "Waiting on Customer", "Scheduled", "Customer Reply", "Not Closed" (pseudo-status) |
| `customer_id`, `contact_id`, `number`, `query`, `user_id`, `mine`, `ticket_search_id`, `parent_id`, `asset_name`, `asset_serial` | |
| `page` | 25/page |
| `comment_format` | `plaintext` (default) \| `richtext` \| `original` |
| `all_comments` | **DEPRECATED**: "In near future (31 Mar, 2026) params will disappear and endpoint returns only first comment" -> do NOT rely on list for comments; use `/tickets/{id}/comments` or `/ticket_comments` |

Response: `{ "tickets": [ { id, number, subject, created_at, updated_at, customer_id, customer_business_then_name, problem_type, status, priority, user_id, contact_id, contact_fullname, resolved_at, due_date, customer_reply (bool), comments:[...], user, ... } ], "meta": { total_pages, page } }`

#### Get one: `GET /tickets/{id}`  (perm: "Tickets - View Details" or "Tickets - View 'Their Ticket' Details")
Response `{ "ticket": { id, number, subject, status, problem_type, priority, customer_id, contact_id, user_id, created_at, updated_at, resolved_at, comments: [...], customer: {id, business_name, firstname, lastname, fullname, email, ...}, contact: {...}|null, user: {id,email,full_name,...}, ... } }`

#### Comments
- `GET /tickets/{id}/comments` (same perms). Params: `sort_by` (created_at|updated_at), `sort_direction` (ASC|DESC), `created_after`, `created_before`, `updated_after`, `updated_before`, `page`, `per_page` (default 10), `comment_format`.
- `GET /ticket_comments` flat cross-ticket list (sorted ticket_id ASC, created_at DESC). Params: `ticket_id`, `customer_id`, `contact_id`, `user_id`, `status`, `since_updated_at` (ticket-level), `comment_created_after`, `comment_created_before`, `page`, `per_page` (<=100), `comment_format`, `ticket_search_id`, `mine`.
Comment object:
```json
{ "id": 1, "created_at": "2025-12-23T00:00:00Z", "updated_at": "...", "ticket_id": 1,
  "subject": "Test Subject", "body": "Test Body", "tech": "Test Tech", "hidden": false,
  "user_id": 1, "is_rich_text": false, "user": {} }
```
Customer vs technician: spec has no explicit flag. Heuristic (**UNVERIFIED**): `user_id` is non-null for comments written by a Syncro user (technician); customer-written comments (email reply / portal) have `user_id: null` and `tech` holds the customer/contact name (or email). Note the POST /tickets example shows the initial comment with `user_id: null, tech: null` when created via API, so API-created comments without a user may also be null - track IDs of comments you post yourself. Ticket-level `customer_reply: true` / status "Customer Reply" indicate the latest activity is from the customer.

#### Create: `POST /tickets`  (perm: "Tickets - Create")
Spec schema declares no `required` list; 422 example `{"error":"Customer required field"}` -> `customer_id` required. `subject` required (422 "Subject can't be blank" on PUT). `problem_type` and `description` can be required by account ticket-form settings ("problem_type": "require" in form config examples). `status` optional (default "New" per example).
```json
{
  "customer_id": 123,
  "contact_id": 456,
  "subject": "Printer offline",
  "problem_type": "Hardware",
  "status": "New",
  "priority": "2 Normal",
  "user_id": 7,
  "comments_attributes": [
    { "subject": "Initial Issue", "body": "User reports...", "hidden": false, "do_not_email": true, "tech": "Haley" }
  ]
}
```
- Initial description = first element of `comments_attributes` (fields: subject, body, hidden, sms_body, do_not_email, tech).
- `priority` strings are account-defined (examples show "High"); **UNVERIFIED** list.
- `problem_type` valid values are account-defined (examples: "Virus", "Hardware"); **UNVERIFIED** where exposed - check `GET /tickets/settings`.
Response 200: `{ "ticket": { id, number, ..., comments:[{id,...}] } }`

#### Add comment: `POST /tickets/{id}/comment`  (perm: "Tickets - Edit")
```json
{ "subject": "Update", "body": "text", "hidden": false, "do_not_email": false, "tech": "Haley", "sms_body": "optional" }
```
Response 200 **includes the comment id**:
```json
{ "comment": { "id": 2, "created_at": "...", "updated_at": "...", "ticket_id": 13, "subject": "Comment Subject", "body": "Comment Body", "tech": "Joe", "hidden": true, "user_id": 1 } }
```
422: `{"success":false,"message":["Body can't be blank","Subject can't be blank"]}` -> subject AND body required.
`hidden: true` = private/internal note; `do_not_email: true` suppresses customer email.

#### Update / status: `PUT /tickets/{id}`  (perm: "Tickets - Edit")
```json
{ "status": "Resolved" }
```
Same body schema as create. Response `{ "ticket": {...} }`.
Valid statuses: account-customizable. Get the live list from `GET /tickets/settings` -> `ticket_status_list`, default example:
`["New","In Progress","Resolved","Invoiced","Waiting for Parts","Waiting on Customer","Scheduled","Customer Reply"]`.
(Account may require outtake form/worksheets before "Resolved": `require_outtake_form_with_ticket` in settings.)

### Customers: `GET /customers` (perm "Customers - List/Search"), `GET /customers/{id}`
Params: `query`, `firstname`, `lastname`, `business_name`, `email`, `id`, `id_not`, `sort` ("firstname ASC"), `include_disabled`, `page`.
Fields: `id, firstname, lastname, fullname, business_name, business_then_name, business_and_full_name, email, phone, mobile, address, city, state, zip, notes, disabled, properties, contacts[], created_at, updated_at`.
**No website/domain field on Customer** in spec examples (`website` appears only on vendors). Domain matching must use `email` domain (customer + contacts) or a custom field in `properties` (**UNVERIFIED**).
Response: `{ "customers": [...], "meta": { total_pages, total_entries, per_page, page } }`; single: `{ "customer": {...} }`.

### Contacts: `GET /contacts?customer_id=&page=`, `GET /contacts/{id}` (perm "Customers - View Detail")
Fields: `id, name, email, phone, mobile, customer_id, account_id, address1, address2, city, state, zip, notes, properties, opt_out, extension, created_at, updated_at`.
List: `{ "contacts": [...], "meta": {...} }`. **Get one returns the contact object at top level (no `contact` wrapper)** per spec example.
No email filter param on /contacts (only `customer_id`, `page`); to find contact by email, page through or use customer `email`/`query` search (**UNVERIFIED** whether `/customers?query=` matches contact emails).

---

## 2. Dynamics 365 Customer Service via Dataverse Web API

Sources:
- Token (client credentials): https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
- Scope rule + app user: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/authenticate-oauth ("For a confidential client, use a scope of "<environment-url>/.default"")
- S2S: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/use-single-tenant-server-server-authentication
- App user: https://learn.microsoft.com/en-us/power-platform/admin/manage-application-users
- Headers/errors: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors
- Paging: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/page-results
- Lookup annotations: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/select-columns
- Create/return=representation/@odata.bind: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api
- Actions: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/use-web-api-actions
- CloseIncident params: https://learn.microsoft.com/en-us/previous-versions/dynamicscrm-2016/developers-guide/mt607498(v=crm.8) (archived; current Learn no longer has a per-action page - authoritative source now is `GET {org}/api/data/v9.2/$metadata`)
- Incident table: https://learn.microsoft.com/en-us/dynamics365/developer/reference/entities/incident
- IncidentResolution: https://learn.microsoft.com/en-us/dynamics365/developer/reference/entities/incidentresolution
- Annotation (incident relationship): https://learn.microsoft.com/en-us/dynamics365/developer/reference/entities/annotation
- State updates: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/special-update-operation-behavior
- Limits: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/api-limits

### Auth (service-to-service)
Setup:
1. Entra ID > App registrations > New registration (single tenant). Certificates & secrets > New client secret. Record client ID, tenant ID, secret. **No API permissions / delegated "user_impersonation" needed for S2S** ("You don't need to grant the Access Dynamics 365 as organization users permission").
2. Power Platform admin center > Manage > Environments > {env} > Settings > Users + permissions > Application users > + New app user > + Add an app (pick the app registration) > Business Unit > security roles > Create. Unlicensed. One app user per app registration per environment.
3. Assign a **custom security role** (docs recommend custom role over broad ones). Needed privileges (**UNVERIFIED exact list** - derive from use): Case (incident) Read/Create/Write/Append/AppendTo; Note (annotation) Read/Create/Append; Account & Contact Read + AppendTo; Case Resolution (incidentresolution) Create; User (systemuser) Read (for createdby expansion).

Token:
```http
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id={appId}&client_secret={urlencoded secret}&grant_type=client_credentials&scope=https%3A%2F%2F{org}.crm.dynamics.com%2F.default
```
Response: `{ "token_type": "Bearer", "expires_in": 3599, "access_token": "..." }` (no refresh token; re-request before expiry).
Error (400): `{ "error": "invalid_scope", "error_description": "AADSTS70011: ...", "error_codes": [70011], "timestamp", "trace_id", "correlation_id" }`.
Region: host is `{org}.crm.dynamics.com` (NA), `crm2` SA, `crm4` EMEA, `crm7` JP etc.; scope must match the env URL.

### Base URL + required headers
`https://{org}.crm.dynamics.com/api/data/v9.2/`
```
Authorization: Bearer {access_token}
Accept: application/json
OData-MaxVersion: 4.0
OData-Version: 4.0
If-None-Match: null                 // docs: include on all requests
Content-Type: application/json      // when body present (docs examples use "application/json; charset=utf-8")
Prefer: odata.include-annotations="*",odata.maxpagesize=100   // comma-separate multiple
```

### Error body
```json
{ "error": { "code": "0x80040265", "message": "..." } }
```
With `Prefer: odata.include-annotations="*"` extra keys: `@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus`, `...SubErrorCode`, `@Microsoft.PowerApps.CDS.HelpLink`, `...TraceText`, `...InnerError.Message`.
Status codes: 200, 201 (POST+return=representation), 204 (create/update/action without body), 400, 401, 403 (PrivilegeDenied etc.), 404, 405, 412 (ConcurrencyVersionMismatch/DuplicateRecord), 413, 429, 501, 503.
Invalid state/status combination -> "Incident does not have valid status code" (set BOTH statecode and statuscode).

### Rate limits (service protection, per user per web server, 300 s sliding window)
- 6,000 requests; 20 min (1,200,000 ms) combined execution time; 52 concurrent requests.
- 429 with `Retry-After` header (seconds). Error codes: `0x80072322` (requests), `0x80072321` (execution time), `0x80072326` (concurrency).
- Debug headers: `x-ms-ratelimit-burst-remaining-xrm-requests`, `x-ms-ratelimit-time-remaining-xrm-requests`. Same limits for application users.

### incidents (EntitySetName `incidents`, PK `incidentid`)
| column | type / notes |
|---|---|
| `incidentid` | GUID |
| `ticketnumber` | String, system-generated case number, read-only |
| `title` | String, ApplicationRequired |
| `description` | Memo |
| `statecode` | 0 Active (default status 1), 1 Resolved (default 5), 2 Cancelled (default 6) |
| `statuscode` | 1 In Progress (s0), 2 On Hold (s0), 3 Waiting for Details (s0), 4 Researching (s0), 5 Problem Solved (s1), 1000 Information Provided (s1), 6 Cancelled (s2), 2000 Merged (s2) (org may add custom values) |
| `prioritycode` | 1 High, 2 Normal (default), 3 Low |
| `modifiedon`, `createdon` | UTC ISO 8601 |
| `customerid` | Customer (polymorphic: account \| contact), SystemRequired. Read as `_customerid_value`; nav props `customerid_account`, `customerid_contact` |
| `primarycontactid` | Lookup contact. Read as `_primarycontactid_value`; nav prop `primarycontactid` |
| notes relationship | `Incident_Annotation` (collection nav prop on incident) |

Account vs contact: request `Prefer: odata.include-annotations="Microsoft.Dynamics.CRM.lookuplogicalname"` (or `"*"`), then read
`_customerid_value@Microsoft.Dynamics.CRM.lookuplogicalname` === `"account"` | `"contact"`. Also `_customerid_value@OData.Community.Display.V1.FormattedValue` = name, `_customerid_value@Microsoft.Dynamics.CRM.associatednavigationproperty` = `customerid_account` / `customerid_contact`.

#### Modified-since query
```http
GET /api/data/v9.2/incidents?$select=incidentid,ticketnumber,title,description,statecode,statuscode,prioritycode,modifiedon,createdon,_customerid_value,_primarycontactid_value
  &$filter=modifiedon gt 2026-09-01T00:00:00Z
  &$orderby=modifiedon asc,incidentid asc
  &$expand=primarycontactid($select=fullname,emailaddress1),customerid_account($select=name,websiteurl,emailaddress1),customerid_contact($select=fullname,emailaddress1)
Prefer: odata.include-annotations="*",odata.maxpagesize=100
```
- Datetime literals in $filter are unquoted ISO 8601 (`modifiedon gt 2026-09-01T00:00:00Z`) - standard OData v4 (**UNVERIFIED** on the pages fetched, but standard).
- Expanding both `customerid_account` and `customerid_contact`: the one not matching returns `null` (**UNVERIFIED** from docs fetched; standard behavior).
- Response: `{ "@odata.context": ..., "value": [ {...} ], "@odata.nextLink": "..." }`.
Paging: `Prefer: odata.maxpagesize=N` (default/max 5,000). Follow `@odata.nextLink` verbatim (don't modify/append), send same maxpagesize each time; stop when absent. No `$skip`. `$top` ignored when maxpagesize is set. Order on a unique column for deterministic paging.

#### Get one
`GET /api/data/v9.2/incidents({id})?$select=...&$expand=...`

#### Create case
```http
POST /api/data/v9.2/incidents?$select=incidentid,ticketnumber
Prefer: return=representation
Content-Type: application/json; charset=utf-8

{
  "title": "Printer offline",
  "description": "User reports ...",
  "prioritycode": 2,
  "customerid_account@odata.bind": "/accounts(00000000-0000-0000-0000-000000000001)",
  "primarycontactid@odata.bind": "/contacts(00000000-0000-0000-0000-000000000002)"
}
```
(for a contact customer: `"customerid_contact@odata.bind": "/contacts(...)"`).
- With `return=representation` -> `201 Created` + JSON body (`incidentid`, `ticketnumber`); **no `OData-EntityId` header** in that case.
- Without it -> `204 No Content` + `OData-EntityId: {org}/api/data/v9.2/incidents(<guid>)` -> parse GUID with `/\(([0-9a-f-]{36})\)$/i`.

#### Add note (annotation)
EntitySetName `annotations`, PK `annotationid`. Columns: `subject` (Title, ApplicationRequired), `notetext` (Memo, RichText format), `isdocument`, `_objectid_value`, `objecttypecode`, `_createdby_value`, `createdon`, `modifiedon`. Nav prop to case: `objectid_incident` (relationship `Incident_Annotation`).
```http
POST /api/data/v9.2/annotations?$select=annotationid,createdon
Prefer: return=representation

{ "subject": "Update from helpdesk", "notetext": "text", "objectid_incident@odata.bind": "/incidents(<incidentid>)" }
```
-> 201 `{ "annotationid": "...", ... }` (or 204 + `OData-EntityId: .../annotations(<guid>)`).

#### List a case's notes
```http
GET /api/data/v9.2/incidents(<id>)/Incident_Annotation?$select=annotationid,subject,notetext,createdon,modifiedon,_createdby_value&$orderby=createdon asc
-- or --
GET /api/data/v9.2/annotations?$select=annotationid,subject,notetext,createdon,_createdby_value&$filter=_objectid_value eq <id>&$orderby=createdon asc
Prefer: odata.include-annotations="OData.Community.Display.V1.FormattedValue"
```
`_createdby_value` = systemuser GUID; `_createdby_value@OData.Community.Display.V1.FormattedValue` = user's name. Notes created by this integration have createdby = the application user (compare with `WhoAmI` -> `GET /api/data/v9.2/WhoAmI` returns `UserId`). Expand alternative: `$expand=createdby($select=fullname,internalemailaddress)` (**UNVERIFIED** nav-prop name `createdby` on annotation; standard system lookup).
GUID literals in $filter are unquoted: `_objectid_value eq 00000000-0000-0000-0000-000000000000`.

#### Resolve case (CloseIncident, unbound action, no return value)
Params: `IncidentResolution` (incidentresolution EntityType, not nullable), `Status` (Edm.Int32, not nullable).
```http
POST /api/data/v9.2/CloseIncident
Content-Type: application/json; charset=utf-8

{
  "IncidentResolution": {
    "@odata.type": "Microsoft.Dynamics.CRM.incidentresolution",
    "subject": "Resolved by helpdesk",
    "description": "optional resolution details",
    "incidentid@odata.bind": "/incidents(<incidentid>)"
  },
  "Status": 5
}
```
-> `204 No Content`. `Status` must be a statuscode valid for statecode 1 (5 Problem Solved, 1000 Information Provided). incidentresolution: `subject` is ApplicationRequired; nav prop to case is `incidentid` (relationship `Incident_IncidentResolutions`). `"@odata.type"` in the entity parameter follows the documented "Specify the table type parameter" rule. Some orgs require `timespent` / billable time on resolution (**UNVERIFIED**).
Cancel: PATCH `{"statecode":2,"statuscode":6}` (**UNVERIFIED** that Update is allowed for cancel on all orgs; `CancelIncident`-style alternative not verified).

#### Reopen (reactivate)
```http
PATCH /api/data/v9.2/incidents(<id>)
If-Match: *
{ "statecode": 0, "statuscode": 1 }
```
-> 204. Docs: SetState is deprecated -> use Update; "When you update the StateCode column, it is important to always set the desired StatusCode." Resolved/cancelled cases are read-only until reactivated (so reactivate before editing other fields).

### accounts / contacts
- `GET /api/data/v9.2/accounts?$select=accountid,name,websiteurl,emailaddress1,modifiedon&$orderby=accountid` (+ maxpagesize paging)
- `GET /api/data/v9.2/contacts?$select=contactid,fullname,emailaddress1,_parentcustomerid_value&$filter=emailaddress1 eq 'user@example.com'`
- String literals single-quoted; escape `'` as `''`.

---

## 3. Duo Auth API v2

Sources:
- https://duo.com/docs/authapi (page "Last updated: July 29th, 2026")
- Official Node client (cross-check of v5 canonicalization): https://github.com/duosecurity/duo_api_nodejs/blob/master/lib/duo_sig.js and lib/main.js (commit b068a84, 2026-08-25)
- Reference v5 impl: https://github.com/duosecurity/duo_hmac_python

Setup: Admin Panel > Applications > Application Catalog > "Auth API" (2FA) > + Add -> integration key (ikey), secret key (skey), API hostname `api-XXXXXXXX.duosecurity.com`. Grant User access (groups / all users). Plans: Premier, Advantage, Essentials, Free, trial.

### Response envelope
- Success: `{ "stat": "OK", "response": { ... } }`
- Failure: `{ "stat": "FAIL", "code": 40002, "message": "Invalid request parameters", "message_detail": "username" }`; HTTP status = first 3 digits of `code`.
- Common codes: 40001 missing params, 40002 invalid param, 40101 missing creds, 40102 invalid ikey, 40103 invalid signature, 40104 missing timestamp, 40105 timestamp too far from server time, 40106 invalid content type, 40301 integration type not permitted, 42901 too many requests ("The user may have exceeded the per-user authentication rate limit").
- Rate limits: no numeric limit published for Auth API (**UNVERIFIED** number); on 429 back off. Official Node client: exponential backoff starting 1 s, factor 2, max wait 32 s, + random 0-1000 ms.

### Endpoints
| Method | Path | Params | Response |
|---|---|---|---|
| GET | `/auth/v2/ping` | none, **unsigned** | `{time}` |
| GET | `/auth/v2/check` | none | `{time}` (validates ikey/skey/signature) |
| POST | `/auth/v2/preauth` | `username` or `user_id` (exactly one), `ipaddr`?, `hostname`?, `trusted_device_token`?, `client_supports_verified_push`? (`"1"`) | `result`: `auth` \| `allow` \| `deny` \| `enroll`; `status_msg`; `devices[]` (only when `auth`): `{device, type:"phone"\|"token", display_name, name, number (masked), capabilities:["auto","push","sms","phone","mobile_otp"], sms_nextcode?}`; `enroll_portal_url` (when enroll); with verified push: `txid`, `verification_code`, `expiration` |
| POST | `/auth/v2/auth` | `username`\|`user_id`, `factor` (`auto`\|`push`\|`passcode`\|`sms`\|`phone`), `async` (`"1"`), `ipaddr`?, `hostname`?; push: `device` (required; ID or `"auto"` = first push-capable device), `type`? (custom string shown in Duo Mobile), `display_username`?, `pushinfo`? (URL-encoded k=v&k=v string, < 20,000 bytes), `txid`? (Verified Push txid from preauth) | sync: `{result:"allow"\|"deny", status, status_msg, trusted_device_token?}`; async: `{txid}` |
| GET | `/auth/v2/auth_status?txid=...` | `txid` | `{result:"waiting"\|"allow"\|"deny", status, status_msg, trusted_device_token?}` - **long-polls** until next status change |

`status` values: `calling`, `answered`, `pushed`, `push_failed` (result waiting); `timeout` (push times out after 60 s), `fraud`, `deny`, `locked_out`, `sent` (result deny); `allow`, `bypass` (result allow).
Polling rule (docs): loop on `/auth_status` while `result === "waiting"`; stop on `allow`/`deny`; don't rely on intermediate status sequence. 400/40002 can mean "long-poll timed out waiting for a status update" -> re-poll.
Verified Duo Push: if policy requires it, send `client_supports_verified_push=1` on preauth, show `verification_code` to user, pass returned `txid` to /auth (expires 60 s). Without it, push may be unavailable when policy requires verified push.

Example push (v5 body, JSON):
```json
{"username":"jdoe@example.com","factor":"push","device":"auto","async":"1","type":"Helpdesk verification","display_username":"jdoe","pushinfo":"ticket=12345&agent=Haley"}
```
(Param values are strings per docs "Values are returned as strings"; sending `"1"` for async matches docs wording `value of "1"`.)

### Request signing - v5 (recommended; v2 = legacy HMAC-SHA1)
Request format:
- GET/DELETE: params URL-encoded in query string.
- POST (v5): params as **JSON object body**, header `Content-Type: application/json` (v2 legacy uses `application/x-www-form-urlencoded`).
- Required headers: `Date`, `Authorization`, `Host` (+ Content-Type for POST).

Canonical string = these 7 lines joined by `\n` (no trailing newline):
1. `date` - RFC 2822, identical to the `Date` header, e.g. `Tue, 21 Aug 2012 17:29:18 -0000`
2. `METHOD` uppercase
3. `host` lowercase (`api-xxxxxxxx.duosecurity.com`)
4. `path` (`/auth/v2/auth`)
5. query string: `key=value` pairs URL-encoded, sorted lexicographically by key, joined `&`; **blank line if none** (always blank for v5 POST since params are in body). Encoding: every byte except `A-Za-z0-9_.~-` is `%XX` with UPPERCASE hex (space = `%20`, `@` = `%40`).
6. body hash: lowercase hex SHA-512 of the exact UTF-8 JSON body bytes sent (POST/PUT/PATCH; `{}` if no params); for GET/DELETE SHA-512 of empty string (`cf83e135...927da3e`).
7. headers hash: lowercase hex SHA-512 of canonicalized `X-Duo-*` headers (names lowercased, sorted, values trimmed, joined as `name1\x00value1\x00name2\x00value2`); if none, SHA-512 of empty string.

Signature: `sig = hex(HMAC-SHA512(key = skey, msg = canonical))` (lowercase hex).
Header: `Authorization: Basic base64(ikey + ":" + sig)`.
Docs example body `{"device":"auto","factor":"push","hostname":"wks01","ipaddr":"10.2.3.4","username":"narroway"}` -> body hash `571f07f529b16c2a...638aeb` (I reproduced this hash). NOTE: the docs' example `Authorization` value could NOT be reproduced from the listed ikey/skey/canonical string (likely illustrative) - validate with Duo's "HMAC Debugger" tool / `/auth/v2/check`.
Body JSON: docs' Python reference uses `json.dumps(params, separators=(",",":"), sort_keys=True)`; official Node client uses plain `JSON.stringify(params)` (insertion order). Only requirement: hash exactly the bytes you send.
Date: docs Python uses `email.utils.formatdate()` -> `Tue, 21 Aug 2012 17:29:18 -0000`; official Node client uses `new Date().toUTCString()` -> `Tue, 21 Aug 2012 17:29:18 GMT` (accepted). Clock skew -> 40105.

TypeScript (Node 22):
```ts
import { createHash, createHmac } from "node:crypto";
const sha512hex = (s: string) => createHash("sha512").update(s, "utf8").digest("hex");
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function duoRequest(ikey: string, skey: string, host: string, method: "GET"|"POST", path: string, params: Record<string,string>) {
  const date = new Date().toUTCString();                      // RFC 2822 (GMT form)
  const isBody = method === "POST";
  const qs = isBody ? "" : Object.keys(params).sort().map(k => `${enc(k)}=${enc(params[k])}`).join("&");
  const body = isBody ? JSON.stringify(params) : "";
  const canon = [date, method, host.toLowerCase(), path, qs, sha512hex(body), sha512hex("")].join("\n");
  const sig = createHmac("sha512", skey).update(canon, "utf8").digest("hex");
  const headers: Record<string,string> = { Date: date, Authorization: "Basic " + Buffer.from(`${ikey}:${sig}`).toString("base64") };
  if (isBody) headers["Content-Type"] = "application/json";
  return fetch(`https://${host}${path}${qs ? "?" + qs : ""}`, { method, headers, body: isBody ? body : undefined });
}
```
(Key sort: plain JS `.sort()` = UTF-16 code-unit order, same as official Node `compare`.)

---

## 4. Okta Verify push via Factors API

Sources:
- User Factors (OpenAPI, extracted from Redocly data): https://developer.okta.com/docs/api/openapi/okta-management/management/tag/UserFactor/ (raw: https://developer.okta.com/docs/api/page-data/shared/oas-openapi/okta-management/management/tags/userfactor.yaml.json)
- Users getUser: https://developer.okta.com/docs/api/openapi/okta-management/management/tag/User/ (raw: .../tags/user.yaml.json)
- API token: https://developer.okta.com/docs/guides/create-an-api-token/main/
- Scopes: https://developer.okta.com/docs/api/oauth2/
- Admin roles: https://help.okta.com/en-us/content/topics/security/administrators-admin-comparison.htm
- Rate-limit headers: https://developer.okta.com/docs/reference/rl-best-practices/

Base: `https://{yourOktaDomain}` (e.g. `acme.okta.com`, or custom domain).

### Auth
- API token: `Authorization: SSWS {token}` (+ `Accept: application/json`, `Content-Type: application/json`).
  - Token inherits the privileges of the admin who created it (use a dedicated service account). Expires after 30 days of non-use (window refreshes on each call). Default token rate limit = 50% of each API's max.
  - Okta "strongly recommends" OAuth 2.0 service apps instead (Bearer access token with scopes).
- OAuth scopes (if using OAuth service app): `okta.users.read` (getUser, listFactors, getFactorTransactionStatus), `okta.users.manage` (verifyFactor).
- Admin role: help.okta.com lists "Password resets, MFA resets" for Super Admin, Org Admin, Help Desk Admin (help desk limited to its groups). Which roles may call **verifyFactor** is not stated -> **UNVERIFIED**; Org Admin/Super Admin should work; test Help Desk Admin (scoped to groups) for least privilege.

### Find user
`GET /api/v1/users/{id}` - `id` = user ID, **login**, or unambiguous login shortname; URL-encode the login (`encodeURIComponent("jdoe@acme.com")`); logins containing `/` must be fetched by ID. Scope `okta.users.read`.
Response fields: `id`, `status` (ACTIVE, ...), `profile.login`, `profile.email`, `profile.mobilePhone`, `profile.primaryPhone`, ... 404 `E0000007` if not found.

### List factors
`GET /api/v1/users/{userId}/factors` -> array of UserFactor:
```json
[{ "id": "opfh52xcuft3J4uZc0g3", "factorType": "push", "provider": "OKTA", "vendorName": "OKTA", "status": "ACTIVE",
   "created": "...", "lastUpdated": "...",
   "profile": { "credentialId": "jane.doe@example.com", "deviceType": "SmartPhone_IPhone", "name": "My Phone", "platform": "IOS", "version": "9.0", "deviceToken": "..." },
   "_links": { "verify": { "href": ".../factors/opfh.../verify" }, ... } }]
```
`factorType` enum: call, email, push, question, signed_nonce, sms, token, token:hardware, token:hotp, token:software:totp, u2f, web, webauthn. `status` enum: ACTIVE, DISABLED, ENROLLED, EXPIRED, INACTIVE, NOT_SETUP, PENDING_ACTIVATION.
Pick `factorType === "push" && provider === "OKTA" && status === "ACTIVE"`. Note: only factors REQUIRED/OPTIONAL in the highest-priority authenticator enrollment policy are returned; policy evaluated with the **admin client's** context (e.g. network zone). `signed_nonce` (FastPass) cannot be verified via this API.

### Issue push challenge
```http
POST /api/v1/users/{userId}/factors/{factorId}/verify
Authorization: SSWS {token}
Accept: application/json
Content-Type: application/json
User-Agent: Haley-Helpdesk/1.0          <- docs: "Required to verify push factors"
X-Forwarded-For: <end-user public IP>   <- optional
```
Body: none for a standard push ("make a request without a body"); or `{"useNumberMatchingChallenge": true}` for number matching.
Optional query: `tokenLifetimeSeconds` (1-86400, default 300).
Response **201**:
```json
{ "expiresAt": "2015-04-01T15:57:32.000Z", "factorResult": "WAITING",
  "_links": { "poll":   { "href": "https://{yourOktaDomain}/api/v1/users/{uid}/factors/{fid}/transactions/{txId}", "hints": { "allow": ["GET"] } },
              "cancel": { "href": "...same...", "hints": { "allow": ["DELETE"] } } },
  "_embedded": { "challenge": { "correctAnswer": 72 } } }   // only with number matching -> tell user to tap 72
```

### Poll
`GET {_links.poll.href}` (= `/api/v1/users/{userId}/factors/{factorId}/transactions/{transactionId}`, scope `okta.users.read`), same headers.
- `{"factorResult":"WAITING", "expiresAt", "profile":{"credentialId"}, "_links":{poll,cancel}, "_embedded"?:{challenge:{correctAnswer}}}` -> poll again (suggest every 2-5 s until `expiresAt`; interval **UNVERIFIED**, not specified)
- `{"factorResult":"SUCCESS"}` -> approved
- `{"factorResult":"REJECTED", "_links":{verify,factor}}` -> user denied
- `{"factorResult":"TIMEOUT", "_links":{verify,factor}}` -> expired
Cancel: `DELETE {_links.cancel.href}` (**UNVERIFIED** response code; not in fetched spec paths list - the path spec only lists GET for transactions).
Full factorResult enum (UserFactorVerifyResult): CHALLENGE, ERROR, EXPIRED, FAILED, PASSCODE_REPLAYED, REJECTED, SUCCESS, TIMEOUT, TIME_WINDOW_EXCEEDED (+ WAITING; CANCELED appears in enum descriptions).

### Errors
`{ "errorCode": "E0000001", "errorSummary": "Api validation failed: {0}", "errorLink": "E0000001", "errorId": "...", "errorCauses": [] }`
400 E0000001 validation; 403 E0000006 no permission; 404 E0000007 not found; 429 E0000047 rate limit.
Rate-limit headers: `X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining`, `X-Rate-Limit-Reset` (UTC epoch seconds). Per-endpoint numeric limits vary by org/plan (**UNVERIFIED** values).

---

## 5. Twilio Programmable Messaging - send SMS

Sources:
- https://www.twilio.com/docs/messaging/api/message-resource
- Official OpenAPI: https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json (POST response code `201`, security `basic`)
- Errors: https://www.twilio.com/docs/usage/twilios-response

```http
POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
Authorization: Basic base64("{AccountSid}:{AuthToken}")     // or base64("{ApiKeySid SK...}:{ApiKeySecret}") with AccountSid still in path
Content-Type: application/x-www-form-urlencoded

To=%2B15558675310&From=%2B15557122661&Body=Your+code+is+123456
```
- Required: `To` (E.164). Sender: exactly one of `From` (Twilio number / alphanumeric ID) or `MessagingServiceSid` (`MG...`). Content: one of `Body` (<= 1,600 chars), `MediaUrl`, `ContentSid`.
- Optional: `StatusCallback` (URL), `ValidityPeriod`, etc.
- Node: `new URLSearchParams({ To, From, Body }).toString()` as body.
- Trial accounts: `To` must be a Verified Caller ID.

Response **201**:
```json
{ "account_sid": "AC...", "api_version": "2010-04-01", "body": "Hi there", "date_created": "Thu, 24 Aug 2023 05:01:45 +0000",
  "date_sent": "...", "date_updated": "...", "direction": "outbound-api", "error_code": null, "error_message": null,
  "from": "+15557122661", "messaging_service_sid": "MG...", "num_media": "0", "num_segments": "1", "price": null, "price_unit": null,
  "sid": "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "status": "queued", "subresource_uris": { "media": "..." },
  "to": "+15558675310", "uri": "/2010-04-01/Accounts/AC.../Messages/SM....json" }
```
`status` enum: queued (initial without Messaging Service), accepted (initial with Messaging Service), scheduled, sending, sent, delivered, undelivered, failed, receiving, received, read, canceled, partially_delivered (deprecated). Final delivery state via `StatusCallback` or `GET .../Messages/{Sid}.json`.

Errors:
```json
{ "status": 400, "message": "No to number is specified", "code": 21201, "more_info": "http://www.twilio.com/docs/errors/21201" }
```
400 bad params (with `code`/`more_info`), 401 bad credentials, 404 (status+message only), 429 concurrency limit -> retry with backoff. Messages exceeding the sender's throughput are queued (not rejected).

---

## 6. Where the registered phone number lives

### 6a. Microsoft Graph - phone authentication methods
Sources:
- https://learn.microsoft.com/en-us/graph/api/authentication-list-phonemethods?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/resources/phoneauthenticationmethod?view=graph-rest-1.0
- Token: same client-credentials flow as section 2 with `scope=https://graph.microsoft.com/.default`

```http
GET https://graph.microsoft.com/v1.0/users/{id | userPrincipalName}/authentication/phoneMethods
Authorization: Bearer {token}
```
No query parameters supported. Returns up to 3 objects (not for B2C users).
```json
{ "value": [
  { "phoneNumber": "+1 2065555555", "phoneType": "mobile",          "smsSignInState": "ready",        "id": "3179e48a-750b-4051-897c-87b9720928f7" },
  { "phoneNumber": "+1 2065555556", "phoneType": "alternateMobile", "smsSignInState": "notSupported", "id": "b6332ec1-7057-4abe-9331-3d72feddfe41" },
  { "phoneNumber": "+1 2065555557", "phoneType": "office",          "smsSignInState": "notSupported", "id": "e37fc753-ff3b-4958-9484-eaa9425c82bc" } ] }
```
- `phoneNumber` format: `+{country code} {number}x{extension}` (space after country code, optional `x` ext) -> **normalize to E.164 for Twilio**: strip spaces, drop `x...` extension.
- `phoneType`: `mobile` (SMS + voice), `alternateMobile` (voice only), `office` (voice only). Fixed ids per type (above). Use `mobile` for SMS.
- `smsSignInState`: notSupported, notAllowedByPolicy, notEnabled, notConfigured, phoneNumberNotUnique, ready, unknownFutureValue.
Permissions:
| type | least privileged | higher |
|---|---|---|
| Application | `UserAuthMethod-Phone.Read.All` | UserAuthenticationMethod.ReadWrite.All, UserAuthenticationMethod.Read.All, UserAuthMethod-Phone.ReadWrite.All |
| Delegated (work/school) | `UserAuthMethod-Phone.Read` | UserAuthenticationMethod.Read(.All), ...ReadWrite(.All), UserAuthMethod-Phone.Read.All / ReadWrite(.All) |
Delegated access to another user also needs Entra role Global Reader, Authentication Administrator, or Privileged Authentication Administrator ("The authentication administrator only sees masked phone numbers"). App-only: grant application permission + admin consent. Errors use Graph format `{ "error": { "code": "...", "message": "...", "innerError": {...} } }` (**UNVERIFIED** from fetched page; standard Graph).

### 6b. Google Admin SDK Directory API - users.get
Sources:
- https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/get
- https://developers.google.com/workspace/admin/directory/reference/rest/v1/users
- https://developers.google.com/workspace/admin/directory/v1/guides/delegation

```http
GET https://admin.googleapis.com/admin/directory/v1/users/{userKey}?projection=basic&viewType=admin_view
Authorization: Bearer {token}
```
- `userKey`: primary email, alias email, or unique user ID.
- Query: `projection` = `basic` \| `custom` \| `full`; `customFieldMask` (with custom); `viewType` = `admin_view` \| `domain_public`.
- Scopes: `https://www.googleapis.com/auth/admin.directory.user.readonly` (least) or `https://www.googleapis.com/auth/admin.directory.user`.
Fields:
- `recoveryPhone`: "Recovery phone of the user. The phone number must be in the E.164 format, starting with the plus sign (+). Example: +16506661212."
- `recoveryEmail`: "Recovery email of the user."
- `phones[]`: `{ value (any format), type (mobile, work, home, work_mobile, custom, ... ), customType, primary }` - profile phones, NOT the 2SV phone.
- `isEnrolledIn2Sv`, `isEnforcedIn2Sv` (read-only).
- Note: the phone used for Google 2-Step Verification is **not exposed** by the Directory API (**UNVERIFIED** - not stated either way on fetched pages; `recoveryPhone` is the account-recovery phone, which is the closest exposed field). Visibility of `recoveryPhone` under `domain_public` is **UNVERIFIED** -> use `admin_view`.
Server auth: service account with domain-wide delegation (Admin console > Security > Access and data control > API controls > Manage Domain Wide Delegation > Add new > Client ID + scopes), then JWT-bearer token with `sub` = an admin user having user-read privileges (need for `sub` impersonation standard for Directory API; guide does not state it explicitly -> **UNVERIFIED**).

---
