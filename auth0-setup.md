# Auth0 setup for the cloud-backend (Phase 1)

This is a one-time setup, done once against your Auth0 tenant, that the
cloud-backend depends on. Steps 1–6 are done in the Auth0 dashboard; step 7
fills in `cloud-backend/.env`.

## 1. Tenant

Use an existing Auth0 tenant or create a new one at https://auth0.com. Note
its domain (`your-tenant.eu.auth0.com` or similar) — this is `AUTH0_DOMAIN`.

## 2. Enable Organizations

**Dashboard → Organizations → Enable.** This is the Auth0 feature each law
firm is modelled as (deployment doc Section 4.1). No further configuration
needed here yet — Organizations get created programmatically by the backend
(`POST /admin/organizations`) as each firm is onboarded, not manually per-org.

## 3. Create the API (this backend's audience)

**Dashboard → Applications → APIs → Create API.**

- Name: `EDD Workbench Cloud Backend`
- Identifier: a URI that doesn't need to resolve, e.g.
  `https://api.edd-workbench.example.com` — this becomes `AUTH0_AUDIENCE`.
- Signing algorithm: RS256 (default).

The backend verifies every incoming JWT was issued for this audience
(`src/auth/jwt.ts`), so a token minted for some other Auth0 API in the same
tenant is rejected.

## 4. Create the SPA application

**Dashboard → Applications → Create Application → Single Page Application.**

- Allowed Callback URLs / Logout URLs / Web Origins: your SPA's dev and
  deployed URLs (e.g. `http://localhost:5183`, plus the CloudFront domain
  once Section 8 infrastructure exists).
- Under **Organizations**, set "Login flow" to prompt for or require an
  organization, since every real user authenticates in the context of their
  firm's Organization — this is what makes Auth0 include the `org_id` claim
  the backend reads (`req.auth.auth0OrgId`).

This application isn't used by anything in this Phase 1 backend directly,
but the SPA needs it to exist before it can log a user in at all.

## 5. Create the Machine-to-Machine application (Management API access)

**Dashboard → Applications → Create Application → Machine to Machine.**

- Authorize it for the **Auth0 Management API**.
- Grant exactly these scopes (least-privilege — this credential is powerful,
  it's what lets the backend provision real accounts):
  - `create:organizations`
  - `create:organization_members`
  - `create:users`
  - `read:users`
- Copy its **Client ID** and **Client Secret** into `cloud-backend/.env` as
  `AUTH0_MGMT_CLIENT_ID` / `AUTH0_MGMT_CLIENT_SECRET`.

This is the credential `src/auth/managementApi.ts` uses server-side only —
it never reaches the browser or the SPA.

## 6. Platform-admin custom claim (Action)

Platform-admin status (us, not a law firm's own admin) needs to travel in
the JWT as a custom claim so `src/auth/jwt.ts` can read it without another
database round-trip. Auth0 requires custom claims to be namespaced as a URL.

**Dashboard → Actions → Library → Build Custom → Post-Login**, name it
`Add platform admin claim`, and use:

```js
exports.onExecutePostLogin = async (event, api) => {
  const claim = "https://edd-workbench.example.com/platform_admin";
  if (event.user.app_metadata?.platform_admin === true) {
    api.idToken.setCustomClaim(claim, true);
    api.accessToken.setCustomClaim(claim, true);
  }
};
```

Deploy it, then attach it to the post-login trigger: **Actions → Triggers →
post-login** (older Auth0 dashboards call this **Actions → Flows → Login** -
same feature, Auth0 renamed "Flows" to "Triggers"). This opens a flow
diagram (Start → ... → Complete); find your action in the right-hand panel
and **drag it onto the canvas**, dropping it on the line between Start and
Complete, then click **Apply**. Just having the action deployed in the
Library is not enough - if it isn't sitting in this diagram, it never runs
and the claim silently never appears in the token, with no error anywhere.
Set `AUTH0_PLATFORM_ADMIN_CLAIM` in `.env` to the same URL used above.

Then create the actual platform-admin user: **Dashboard → User Management →
Users → Create User** (use the `Username-Password-Authentication`
connection), open the created user, and under **Metadata → App Metadata**
(`app_metadata`) set:

```json
{ "platform_admin": true }
```

**This must go in App Metadata, not User Metadata** - they're adjacent
fields on the same screen and easy to mix up, but the Action above reads
`event.user.app_metadata` specifically. Setting the flag in User Metadata
instead fails exactly as silently as skipping the trigger step above: no
error, the claim is just absent from every token issued to that user. If a
user is logging in fine but every API call comes back `403
no_matching_account` (or the platform-admin routes 403 even though you're
sure the account is right), decode the JWT (base64url-decode the middle
segment - no secret needed) and check whether the claim is actually present
before assuming anything else is wrong.

This user is intentionally not tied to any of our own `organizations` rows
— they operate above tenant scope (`req.tenant.isPlatformAdmin`).

## 7. Fill in `cloud-backend/.env`

```
AUTH0_DOMAIN=your-tenant.eu.auth0.com
AUTH0_AUDIENCE=https://api.edd-workbench.example.com
AUTH0_MGMT_CLIENT_ID=<from step 5>
AUTH0_MGMT_CLIENT_SECRET=<from step 5>
AUTH0_PLATFORM_ADMIN_CLAIM=https://edd-workbench.example.com/platform_admin
DATABASE_URL=postgres://edd_cloud_backend:edd_cloud_backend_dev@localhost:5432/edd_cloud_backend
```

## 8. Getting a test token to call the API manually

A client-credentials token (from the M2M app in step 5) is **not** a valid
caller token for this API — it has no `sub` representing a real user and no
`org_id`. You need a real user login. The simplest options:

- **Auth0 CLI**: `auth0 login`, then `auth0 test token` walks through a
  browser login against your tenant and prints a usable access token.
- **Postman**: use its built-in Auth0/OAuth2 helper with Grant Type
  "Authorization Code (With PKCE)", pointing at the SPA application from
  step 4 and the audience from step 3.

Once you have a token for the platform-admin user (step 6), the first real
call to make is onboarding a firm:

```
POST /admin/organizations
Authorization: Bearer <platform-admin token>
Content-Type: application/json

{ "name": "smith-co", "displayName": "Smith & Co", "adminEmail": "admin@smithco.example.com" }
```

That creates the firm's Auth0 Organization, its `organizations` row, and its
first admin user (who gets a password-reset email to set their own
password) — after which that admin can log in, and their token will carry
the `org_id` for their firm, letting them create groups and users of their
own via `/groups` and `/users`.
