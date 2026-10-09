> Source-verified API notes behind Haley's SyncroMSP, ConnectWise PSA, Autotask PSA, HaloPSA, Dynamics 365, Duo, Okta and Twilio integrations (compiled September 2026). Items marked UNVERIFIED weren't confirmed in official docs; the adapters handle them defensively and they are worth re-checking against a live account.

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

## 7. ConnectWise PSA (Manage) REST API 3.0

Sources:
- Official OpenAPI schema as shipped in the `connectwise-rest` npm package (generated from ConnectWise's spec; `dist/ManageTypes.d.ts`, content type `application/vnd.connectwise.com+json; version=2025.16`): https://www.npmjs.com/package/connectwise-rest (README: https://github.com/covenanttechnologysolutions/connectwise-rest)
- ConnectWise Developer Network (login required, not fetched): https://developer.connectwise.com/Products/ConnectWise_PSA/REST

### Base URL and auth
```
https://{site}/v4_6_release/apis/3.0          // site = api-na.myconnectwise.net, api-eu…, api-au…, or on-premises host
Authorization: Basic base64("{companyId}+{publicKey}:{privateKey}")
clientId: {developer clientId GUID}
```
- `v4_6_release` is the library's default entry point; the auth string and required `clientId` header are as documented by the library and widely used. Keys come from System > Members > API Members > API Keys (private key shown once).
- Rate limits: not documented in the schema (**UNVERIFIED**); adapter reports 429 readably and the next sync resumes.

### Paging / queries (schema: `getServiceTickets` query params)
`conditions`, `childConditions`, `customFieldConditions`, `orderBy`, `fields`, `page`, `pageSize`, `pageId`. Responses are bare JSON arrays. `pageSize` max 1000 (library default; **UNVERIFIED** in the spec). Adapter uses `pageSize=100`, stops on a short page.
- Condition syntax `lastUpdated > [2026-09-27T09:00:00Z]`, strings double-quoted (`board/name="Help Desk"`): conventional, **UNVERIFIED** against the (login-only) docs. Adapter orders by `id asc` so paging is stable while tickets change, then sorts by `_info.lastUpdated` itself.

### Tickets (`Ticket` schema)
`id`, `summary` (max 100, required), `recordType`, `board` (BoardReference {id,name}), `status` (ServiceStatusReference {id,name,sort}), `company` (required; {id,identifier,name}), `contact`, `contactName`, `contactEmailAddress` (max 250), `priority` (PriorityReference), `closedFlag`, `closedDate`, `_info` (string map incl. `lastUpdated`, `dateEntered`).
- `initialDescription` / `initialInternalAnalysis` / `initialResolution`: "Only available for POST, will not be returned in the response." So the description is read back as the first Discussion note.
- `processNotifications` on Ticket: "Can be set to false to skip notification processing when adding or updating a ticket (Defaults to True)."
- `GET /service/tickets`, `GET/PATCH /service/tickets/{id}`, `POST /service/tickets` (Haley sends `summary`, `initialDescription`, `board:{name}`, `company:{id}`, `contactEmailAddress`, `priority:{id}`). Board by name in a reference: **UNVERIFIED** (commonly used).
- PATCH body is JSON Patch (`PatchOperation`: `{op: "add"|"replace"|"remove", path, value}`). Status: `[{"op":"replace","path":"status","value":{"id":N}}]`.
- Statuses are per board: `GET /service/boards/{id}/statuses` (fields `id`, `name`, `inactive`, `closedStatus`). Adapter resolves the configured name (or stock names: New / In Progress / Waiting Customer… / Resolved, Completed, Closed, >Closed) to an id on the ticket's own board; a board without a waiting status falls back to in-progress.
- Priorities: `GET /service/priorities`; stock names "Priority 1 - Emergency Response" … "Priority 4 - Schedule Maintenance" (**UNVERIFIED**, matched by keyword).
- Companies: `GET /company/companies` (`id`, `identifier`, `name`, `website`, `deletedFlag`). No email field, so domains come from `website`.

### Notes (`ServiceNote` schema; `GET/POST /service/tickets/{parentId}/notes`)
`id`, `ticketId`, `text`, `detailDescriptionFlag` (Discussion), `internalAnalysisFlag` (Internal), `resolutionFlag`, `issueFlag`, `member` (MemberReference), `contact` (ContactReference), `customerUpdatedFlag`, `processNotifications`, `dateCreated`, `createdBy`, `internalFlag`, `externalFlag`.
- Customer-authored = no `member` and a `contact` (or `externalFlag`): how email-connector replies and portal updates appear (**UNVERIFIED** heuristic; Haley's own notes are excluded by id anyway).
- Whether a Discussion note emails the contact depends on the board's notification setup plus `processNotifications` (**UNVERIFIED**). Adapter defaults to `processNotifications: false` and `notifiesCustomer = false` (Haley emails the requester); the `emailContacts` setting flips both.

---

## 8. Autotask PSA REST API v1.0

Sources:
- Zone lookup: https://autotask.net/help/developerhelp/Content/APIs/REST/API_Calls/REST_ZoneInformation.htm
- Auth headers: https://autotask.net/help/DeveloperHelp/Content/APIs/REST/General_Topics/REST_Security_Auth.htm
- Queries: https://autotask.net/help/DeveloperHelp/Content/APIs/REST/API_Calls/REST_Basic_Query_Calls.htm and https://autotask.net/help/DeveloperHelp/Content/APIs/REST/API_Calls/REST_Advanced_Query_Features.htm
- Picklists: https://autotask.net/help/developerhelp/Content/APIs/REST/API_Calls/REST_EntityInformationCall.htm
- Entities: https://autotask.net/help/DeveloperHelp/Content/APIs/REST/Entities/TicketsEntity.htm, https://autotask.net/help/DeveloperHelp/Content/APIs/REST/Entities/TicketNotesEntity.htm

### Zone and auth
```
GET https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation?user={apiUsername}
-> { "zoneName": "America East", "url": "https://webservices3.autotask.net/atservicesrest/", "webUrl": "...", "ci": 20264 }
```
"ZoneInformation requests do not require authentication" - Haley sends no credentials to it. Base = `{url}v1.0`.
Headers on every other call: `ApiIntegrationCode` (API tracking identifier), `UserName` (API-only user), `Secret`, `Content-Type: application/json`. Requires the API User security level.

### Queries and paging
- `POST /{Entity}/query` body `{"filter":[{"op":"gt","field":"lastActivityDate","value":"2026-09-27T09:00:00.000Z"}]}`; ops `eq, noteq, gt, gte, lt, lte, beginsWith, endsWith, contains, exist, notExist, in, notIn`.
- Response `{ items: [...], pageDetails: { count, requestCount (500), prevPageUrl, nextPageUrl } }`; `MaxRecords` 1-500; results "sorted by internal ID from lowest to highest". `nextPageUrl` carries `paging=` and `search=` in its query string; adapter GETs it (method not stated in the docs, **UNVERIFIED**).
- `POST /{Entity}/query/count` -> `{ queryCount }` (used by Test).
- Single record: `GET /{Entity}/{id}` -> `{ item }`. Create -> `{ itemId }`. Update: `PATCH /{Entity}` with `id` in the body (**UNVERIFIED** wording; standard Autotask REST convention).

### Time zone
"The REST API stores and returns all time data in Coordinated Universal Time (UTC)." (Tickets entity page.) The UI shows resource-local (often Mountain for older tenants) times; the API doesn't. Adapter still treats a time without a zone designator as UTC.

### Tickets
Required on create: `companyID`, `priority` (active), `status`, `title` (255); `dueDateTime` required unless the ticket category sets both a default due date and time; `queueID` depending on category. `description` max 8000. `ticketNumber` auto ("TYYYYMMDD.nnnn"). `lastActivityDate` (read-only) moves with notes/time entries; `lastTrackedModificationDateTime` excludes activity.
- `status`/`priority` are per-tenant picklists. `GET /Tickets/entityInformation/fields` returns `fields[]` with `isPickList` and `picklistValues[] {value, label, isDefaultValue, sortOrder, parentValue, isActive, isSystem}`; the adapter maps by label. Stock ids used as fallbacks: status 1 New, 5 Complete (system), 7 Waiting Customer, 8 In Progress; priority 1 High, 2 Medium, 3 Low, 4 Critical (**UNVERIFIED** beyond 1 New / 5 Complete; all overridable in the connection settings).
- Contacts: `GET /Contacts/{id}` (`emailAddress`, `firstName`, `lastName`). Companies: `POST /Companies/query` (`companyName`, `webAddress`, `isActive`).

### TicketNotes
Fields: `id`, `ticketID` (req), `title` (250), `description` (req, 32000), `noteType` (req, picklist), `publish` (req, picklist), `createDateTime`, `lastActivityDate`, `createdByContactID`, `creatorResourceID`, `impersonator*ResourceID`.
- Read: `POST /TicketNotes/query` filtered on `ticketID`. Create: `POST /Tickets/{parentId}/Notes` (child-collection URL; **UNVERIFIED** in the fetched page, standard REST parent/child pattern).
- `publish` numeric meaning isn't stated on the entity page; docs say "API queries for TicketNote entities with publish = 1 include all System Workflow Notes" and impersonated contact notes must be published to "ALL", which points to 1 = All Autotask Users, 2 = Internal Only (third-party summaries disagree -> **UNVERIFIED**). Adapter reads the labels from `/TicketNotes/entityInformation/fields` and only falls back to 1/2.
- `noteType = 13` is the System Workflow Note (docs); these are skipped. Haley uses the picklist's default note type.
- Customer-authored = `createdByContactID` set (client portal, contact impersonation, emails from a known contact: **UNVERIFIED** for the email processor).
- Notes created through the API don't trigger Autotask's notification emails (no notify option in the entity; **UNVERIFIED**), so `notifiesCustomer = false` and Haley emails replies herself.

---

## 9. HaloPSA REST API

Sources:
- Halo's own reference is served per instance at `https://{instance}/apidoc` (public copy: https://halopsa.com/apidoc). Details below were checked against a mirror of the v2 Swagger spec: https://kb.dtctoday.com/books/halopsa-api-reference (pages: ticket-endpoints, action-endpoints, clients-sites-endpoints, ticket-configuration-endpoints) and the HaloAPI PowerShell module's parameter docs: https://powershellgallery.com/packages/HaloAPI/1.7.0/Content/Public/Get/Get-HaloTicket.ps1. Not first-party -> treat as **UNVERIFIED** until checked against a live `/apidoc`.
- Token endpoint: n8n and other integrators' docs (e.g. https://docs.n8n.io/integrations/builtin/credentials/halopsa/).

### Auth
```
POST https://{instance}/auth/token[?tenant={tenant}]
Content-Type: application/x-www-form-urlencoded
grant_type=client_credentials&client_id=...&client_secret=...&scope=all
-> { access_token, token_type, expires_in }
Authorization: Bearer {access_token}   on https://{instance}/api/...
```
`tenant` only for Halo-hosted instances that show one on the API page. App: Configuration > Integrations > HaloPSA API > View Applications, "Client ID and Secret (Services)".

### Paging
`pageinate=true` (Halo's spelling), `page_size` (max 100), `page_no` (1-based). List responses wrap rows: `{ record_count, tickets: [...] }`, `{ record_count, clients: [...] }`, `{ record_count, actions: [...] }`.

### Tickets
- `GET /api/Tickets` params include `datesearch` (date field to search, e.g. `dateoccured`, `datecleared`), `startdate`, `enddate`, `order`, `orderdesc`, `client_id`, `open_only`, `closed_only`. Haley uses `datesearch=lastactiondate&startdate={cursor}` (**UNVERIFIED** that `lastactiondate` is accepted) and re-filters client-side on max(`last_update`, `lastactiondate`), so an ignored filter only costs paging.
- `GET /api/Tickets/{id}?includedetails=true`. Fields used: `id` (also the ticket number), `summary`, `details` (may be HTML), `client_id`, `client_name`, `user_name`, `user_email`, `status_id`, `priority_id`, `lastactiondate`, `last_update`, `dateoccurred`. Times come back without a zone designator; treated as UTC (**UNVERIFIED**).
- Create and update both `POST /api/Tickets` with an array (`[{summary, details, client_id, status_id, priority_id, user_email?, tickettype_id?}]` / `[{id, status_id}]`). Response: the saved ticket (object or array; adapter accepts both).
- Statuses: `GET /api/Status` -> array of `{id, name, type, shortname}`. Adapter maps by name; built-in ids 1 New, 2 In Progress, 9 Closed are fallbacks (**UNVERIFIED**); a missing waiting status falls back to in progress. All overridable in settings.
- Priorities: default 1 Critical, 2 High, 3 Medium, 4 Low (**UNVERIFIED**; priorities belong to SLAs).

### Actions (the ticket conversation)
- `GET /api/Actions?ticket_id={id}&excludesys=true` (`excludesys` omits system actions; also `excludeprivate`, `conversationonly`, `count`).
- Fields: `id` (per ticket), `ticket_id`, `outcome`/`outcome_id`, `note`, `note_html`, `who`, `who_type` (0 Agent, 1 End User), `who_agentid`, `hiddenfromuser`, `datetime`, `sendemail`, `emailto`, `emailfrom`, `emaildirection`.
- `POST /api/Actions` takes an array; Haley sends `[{ticket_id, outcome: "Email User" | "Private Note", note, hiddenfromuser, sendemail}]`. Outcome names are the stock ones (**UNVERIFIED** per instance). Public replies set `sendemail: true`, so Halo emails the end user (`notifiesCustomer = true`, **UNVERIFIED**: check the action's email template on a live instance).
- Customer-authored = `who_type == 1` (fallback: no `who_agentid`).

---

## 7. NinjaOne RMM public API v2 (connector: `server/src/connectors/ninjaone/`)
Sources:
- Official OpenAPI spec (downloaded 2026-09-29): https://app.ninjarmm.com/apidocs/NinjaRMM-API-v2.json (rendered at https://app.ninjarmm.com/apidocs-beta/)
- OAuth scopes: https://www.ninjaone.com/docs/application-programming-interface-api/oauth-token-configuration/
- Device filter syntax PDF (linked from the spec, not machine-readable): https://resources.ninjarmm.com/API/Ninja+RMM+Public+API+v2.0.5+Device+Filter+Syntax.pdf

Auth: `POST https://{instance}/ws/oauth/token`, form body `grant_type=client_credentials&client_id=…&client_secret=…&scope=monitoring management`, returns `access_token`, `expires_in`; API calls send `Authorization: Bearer`. Instances `app`, `us2`, `eu`, `ca`, `oc` `.ninjarmm.com` each answered the token endpoint with `{"resultCode":"Client app not exist"}` to a dummy client (probed 2026-09-29); `uk.ninjarmm.com` does not resolve. Scopes per NinjaOne docs: **monitoring** (read-only monitoring data and org structure), **management** ("modification of device and organization information, including … running scripts"), **control** (remote access). Haley requests `monitoring management` only; that reboot needs `management` rather than `control` is **UNVERIFIED** (the spec's operations don't list scopes). Token lifetime handling assumes `expires_in` seconds (standard OAuth; **UNVERIFIED** value).

Endpoints used (all confirmed in the OpenAPI spec):
| Call | Notes |
|---|---|
| `GET /v2/organization/{id}` | org name for `test()` |
| `GET /v2/organization/{id}/devices?pageSize=&after=` | org-scoped device list; `after` = last device id of the previous page |
| `GET /v2/organization/{id}/end-users` | end users (uid, email) to resolve a device's `assignedOwnerUid` to an email for policy targets |
| `GET /v2/device/{id}` | AgentDevice: `organizationId`, `offline`, `lastContact`, `assignedOwnerUid`, `os{name,buildNumber,releaseId,lastBootTime,needsReboot}`, `system{manufacturer,model,serialNumber,…}`, `lastLoggedInUser` (a username such as `DOMAIN\user`, not an email) |
| `GET /v2/device/{id}/volumes` | `driveLetter`, `capacity`, `freeSpace` (bytes) |
| `GET /v2/device/{id}/os-patches?status=PENDING` | the `status` filter exists; the literal value `PENDING` is **UNVERIFIED** |
| `GET /v2/alerts?df=…` | alerts with `deviceId`, `severity`, `priority`, `subject`, `message`, `createTime` |
| `GET /v2/automation/scripts` | `id`, `name`, `description`, `active`, `language`, `operatingSystems`, `scriptVariables` |
| `POST /v2/device/{id}/script/run` | body `{type: "SCRIPT"\|"ACTION", id (int), uid (built-in action), parameters (string), runAs (string)}`; response `default` (no body assumed) |
| `POST /v2/device/{id}/reboot/{mode}` | `mode` enum `NORMAL`\|`FORCED`, body `{reason}`; Haley only sends `NORMAL` |

**UNVERIFIED**:
- Device filter for alerts: Haley sends `df=org = {id}` (third-party examples only; the official PDF is font-encoded). Haley also filters alerts client-side to the org's device ids, so a misread filter can only return fewer alerts, never another client's.
- `runAs` values: the spec only says "Credential role/identifier". Haley offers `system` (default) and `loggedonuser`; confirm against `GET /v2/device/{id}/scripting/options` → `credentials.roles`.
- Timestamps are treated as epoch seconds (fractional); values ≥ 1e12 are treated as milliseconds.
- UI path for creating the API app ("Administration → Apps → API → Client app IDs", platform "API Services (machine-to-machine)").

Safety in Haley: every device-specific call re-fetches the device and refuses it unless `organizationId` equals the client's configured organization; `ninja_run_script` (write) and `ninja_reboot_device` (destructive) resolve the device owner's email as the policy target (else `[]` = unknown target), and a script whose name contains wipe/format/erase/uninstall/disable/delete/remove/… always waits for a technician (`guard`).

## 8. IT Glue API (connector: `server/src/connectors/itglue/`)
Source: https://api.itglue.com/developer/ (fetched 2026-09-29)

- Base URLs (confirmed): `https://api.itglue.com`, EU `https://api.eu.itglue.com`, Australia `https://api.au.itglue.com`.
- Headers (confirmed): `x-api-key: {key}`, `Content-Type: application/vnd.api+json` (only with a payload). JSON:API: `{data: {id, type, attributes: {kebab-case…}, relationships}}`.
- Rate limit (confirmed): 3000 requests per 5 minutes, 429 when exceeded.
- `GET /organizations/:organization_id/relationships/documents` (confirmed): filters `filter[document_folder_id]` (omit = root only; `null` = all folders), `page[size]`, `page[number]`. No name filter, so Haley matches names client-side.
- `GET /organizations/:organization_id/relationships/documents/:id` (confirmed): includes `attributes.sections[]` with `attributes.resource-type` (`Document::Heading`/`Text`/`Gallery`/`Step`), `content` (raw HTML), `rendered-content`, `level` (headings), `sort`.
- `GET /organizations/:organization_id/relationships/configurations` (confirmed): filters include `filter[name]`, `filter[archived]`, `filter[serial_number]`, …; attributes `name`, `hostname`, `primary-ip`, `serial-number`, `configuration-type-name`, `operating-system-name`, `warranty-expires-at`, `organization-id`, ….
- `GET /organizations/:id` used by `test()` (standard resource; response shape `data.attributes.name` assumed, **UNVERIFIED** in the fetched excerpt).
- Flexible assets need `filter[flexible-asset-type-id]` and their traits can hold password-typed fields under arbitrary names, so Haley doesn't expose them yet.
- Passwords: Haley never calls `/passwords` (the client refuses any path containing "password"), and `stripSecrets()` removes password/secret/token/OTP-like keys. Recommend generating the API key with password access disabled (**UNVERIFIED** UI wording: Account → Settings → API Keys, "Allow access to passwords").
- Every returned document/configuration is checked for `organization-id` = the configured organization.

## 9. Hudu API v1 (connector: `server/src/connectors/hudu/`)
Sources: each instance's own `/developer` page (not public); community clients https://github.com/lwhitelock/HuduAPI (PowerShell module, `Public/Get-HuduArticles.ps1`, `Get-HuduAssets.ps1`, `Get-HuduCompanies.ps1`, `Private/Invoke-HuduRequest.ps1`) and https://glama.ai/mcp/servers/ZenixSolutions/hudu-mcp/tools/hudu_list_articles. The vendor article https://support.hudu.com/hc/en-us/articles/11422780787735-REST-API returned 403 to automated fetches.

- Base `{instance}/api/v1`, header `x-api-key` (community-confirmed).
- `GET /api/v1/articles?company_id=&page=` → `{articles: [...]}`; `GET /api/v1/articles/{id}` → `{article: {...}}` with `id`, `name`, `content` (HTML), `company_id` (null = global KB), `draft`, `url`, `updated_at` (community-confirmed).
- `GET /api/v1/assets?company_id=&archived=&name=` → `{assets: [...]}` with `fields: [{label, value}]` (community-confirmed).
- `GET /api/v1/companies/{id}` → `{company: {...}}` (used by `test()`, community-confirmed).
- **UNVERIFIED**: the `search` query parameter on `/articles` and `/assets` (community MCP servers document it; the PowerShell module only uses `name`), and `page_size`. If ignored, the tool returns the company's first page instead of search matches.
- Passwords: Haley never calls `/asset_passwords`; asset fields whose label looks like a password/secret/PIN/OTP are dropped. Global articles (`company_id` null) and other companies' items are filtered out.

## 10. Generic REST API connector (`server/src/connectors/rest/`)
No vendor API. Rules enforced in code and pinned by `server/test/connectors-more.test.ts`:
- Base URL: `https:` only, no `user:pass@`, no query/fragment, no IP literals (WHATWG URL parsing normalizes `2130706433`/`0x7f.1` forms to dotted quads first), no `localhost`, single-label names or `.local/.internal/.lan/.home/.corp/.arpa/.localhost/.intranet/.localdomain` suffixes. DNS is not resolved, so a public name pointing at a private address (DNS rebinding) is not caught; run Haley with egress controls if that matters.
- Paths: must start with a single `/`; no `//`, `\`, `.`/`..` segments (also after percent-decoding), URL schemes, `?`/`#`, whitespace or control characters. Optional `allowedPaths` prefixes match on segment boundaries (`/v1/users` allows `/v1/users/42`, not `/v1/usersX`).
- Requests: one configured auth header (never `Host`, `Cookie`, `Content-Type`…; no CR/LF in the value), `redirect: "manual"` with any 3xx treated as an error, 20-second timeout, at most 1 MB read, ~20 KB returned (`truncated: true` beyond that). The auth value (and the bare token after `Bearer `/`Basic `) is replaced with `[redacted]` in every response and error.
- Tools: `api_<name>_get` (read); with `allowWrites=true` also `api_<name>_write` (POST/PUT/PATCH, risk write) and `api_<name>_delete` (risk destructive). One REST integration per client for now (the integrations route allows one per provider).

## Time entries for Haley's work (researched 2026-10-02)

`PsaAdapter.logTime` records Haley's work on a synced ticket when the connection's **Log Haley's time** option is on. Every PSA records it as non-billable, so technicians decide what's invoiced.

### SyncroMSP

`POST /tickets/{id}/timer_entry` with `start_at`, `end_at`, `duration_minutes`, `notes` and an optional `product_id`. This creates a recorded entry that hasn't been charged. Source: api-docs.syncromsp.com/swagger.json.

### ConnectWise PSA

`POST /time/entries`. Source: the official OpenAPI types (unpkg.com/connectwise-rest/dist/ManageTypes.d.ts); ConnectWise's own developer docs require a login.

**Body:**
- `chargeToType: "ServiceTicket"` and `chargeToId`
- `member: { identifier }`
- `timeStart` and `timeEnd`, with no fractional seconds
- `notes`
- `billableOption: "DoNotBill"`
- the three `addTo…Flag` fields set to false, so no Discussion note is added and no contact email is sent
- `workType` and `workRole` ids, optional

**Requirements:**
- A time period must exist for the year.
- **Unverified:** whether an API member can own entries. Haley sends the configured member identifier explicitly.

### Autotask PSA

`POST /TimeEntries`. Source: autotask.net/help/DeveloperHelp/Content/APIs/REST/Entities/TimeEntriesEntity.htm.

**Body:**
- `ticketID`, `resourceID` and `roleID`
- `startDateTime` and `endDateTime` (UTC)
- `summaryNotes` (required for ticket entries)
- `isNonBillable: true` and `showOnInvoice: false`

**roleID:**
- It must match the ticket's `assignedResourceroleID` (lowercase "role"), unless the account lets users change the role on ticket time.
- Haley uses the configured role, else the ticket's assigned role, else the resource's default active `ResourceServiceDeskRoles` row.

**Requirements:**
- Proxy Time Entry must be on so the API user can add time for that resource. Alternatively use the `ImpersonationResourceId` header, which Haley doesn't use.
- The account may refuse time on Complete tickets.
- **Unverified:** whether the API-only user can be the resource itself.

### HaloPSA

Time is recorded on actions: `POST /api/Actions`, sent as an array.

**Body:**
- `timetaken`, in decimal hours
- `actionarrivaldate` and `actioncompletiondate`
- `outcome`, configurable (default "Private Note")
- `hiddenfromuser: true` and `sendemail: false`
- `actisbillable: false`
- `chargerate`, an optional id for a non-billable charge type

**Sources:**
- Field names come from the first-party apidoc bundle (halopsa.com/apidoc).
- Units come from a third-party mirror of the v2 Swagger (kb.dtctoday.com).

**Handling:** the new action's id is added to the link's seen comments, so the sync doesn't import it back as a technician note.

**Unverified:** how `nonbilltime` relates to `timetaken`. Haley doesn't send `nonbilltime`.

## Closed tickets for "What would Haley handle?" (added 2026-10-08)

`PsaAdapter.listClosedTickets(from, to, { max })` reads one page at a time until `max` (5,000 plus one, to detect the cap). These queries follow the vendors' documented filters but **haven't been run against live tenants yet**.

| PSA | Query | Time | Unverified |
|---|---|---|---|
| ConnectWise | `GET /service/tickets?conditions=closedFlag=true and closedDate>=[from] and closedDate<[to]&fields=id,summary,initialDescription,company,dateEntered,closedDate,actualHours,type,subType&orderBy=closedDate desc&pageSize=100&page=N` | `actualHours` × 60 | Whether `initialDescription` is returned through `fields` on every version. |
| HaloPSA | `GET /Tickets?closed_only=true&datesearch=dateclosed&startdate=&enddate=&order=dateclosed&orderdesc=true&pageinate=true&page_size=100&page_no=N` | `timetaken` (hours) × 60 | The date filter's time zone. Haley also filters `dateclosed` to the range itself. |
| Syncro | `GET /tickets?status=Resolved&since_updated_at=from&page=N` | not available (null) | Tickets resolved and later updated are included by `since_updated_at`, so Haley filters on `resolved_at` (falling back to `updated_at`). |
| Autotask | `POST /Tickets/query` with `status eq <Complete>` (from the status picklist, 5 by default), `completedDate gte from` and `completedDate lt to`, following `pageDetails.nextPageUrl` | not available (null): tickets have no actual-hours field, and summing `TimeEntries` per ticket is too many calls | Whether `completedDate` is set on every completed ticket (workflow rules can complete tickets without it). Category is the `issueType` label. |
| Dynamics 365 | `GET /incidents?$filter=statecode eq 1 and modifiedon ge from&$orderby=modifiedon desc&$expand=customerid_account($select=name),Incident_IncidentResolutions($select=actualend,timespent)`, following `@odata.nextLink` | the resolutions' `timespent` (minutes) | The navigation property name `Incident_IncidentResolutions` on every version, and whether `timespent` is filled when the resolution dialog's billable time is left empty. Close time is the latest `actualend`, or `modifiedon` when there is no resolution. |

### Checking them on a live tenant

The **Check fields** button on the PSA sync page (or `npm run probe:psa -- <connection id or name>` on the server) runs the connection test, this query for the last 30 days (at most 5 tickets) and one ticket read. It reports each field's type and how many tickets had it filled in, never the values, and makes no changes. Empty fields that should have values (`minutesSpent`, `customerName`, `category`) mean the query needs adjusting for that PSA.

Each PSA's report is marked **Preview** in the dashboard until it's checked. When a check passes, record it here and remove `"insights"` from the provider's `preview` list in `server/src/psa/registry.ts`.

| PSA | Reports query checked | By, on |
|---|---|---|
| ConnectWise | not yet | |
| HaloPSA | not yet | |
| Syncro | not yet | |
| Autotask | not yet | |
| Dynamics 365 | not yet | |

