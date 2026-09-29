# Connecting Microsoft 365 clients

Haley supports two ways to connect a client's Microsoft 365 tenant. Both give Haley the same tools.

| | **Admin consent (recommended for MSPs)** | **App registration per client** |
|---|---|---|
| Setup per client | The client's Global Admin (or your partner admin via GDAP) clicks one link | Create an app, add permissions, create a secret, paste three values |
| Secrets | One secret for your MSP app, stored as a server environment variable | One secret per client, encrypted in Haley's database |
| Secret rotation | Once, for every client | Per client |
| Settings | Tenant discovery pre-fills domains, the Teams tenant and protected admins | Typed in by hand |

## 1. Register your MSP app (once)

In **your own** Entra tenant (the MSP's, not a client's):

1. **App registrations → New registration.**
   - Name: `Haley` (clients see this name on the consent screen).
   - Supported account types: **Accounts in any organizational directory (multitenant)**.
   - Redirect URI: platform **Web**, value `https://<your Haley host>/hooks/m365/consent`. It must match `HALEY_PUBLIC_URL` exactly. Microsoft requires https except for `localhost`.
2. **API permissions → Add a permission → Microsoft Graph → Application permissions**, and add:

   | Permission | Used for |
   |---|---|
   | `User.ReadWrite.All` | Users, licenses, creating users, blocking sign-in |
   | `Group.ReadWrite.All` | Group and shared-mailbox membership |
   | `Directory.Read.All` | Directory lookups |
   | `RoleManagement.Read.Directory` | Finding admins during discovery (protected accounts) |
   | `UserAuthenticationMethod.ReadWrite.All` | MFA method review, Temporary Access Passes, password resets |
   | `DeviceManagementManagedDevices.ReadWrite.All` | Intune devices, installed apps, sync |
   | `DeviceManagementManagedDevices.PrivilegedOperations.All` | Restart, retire and wipe |
   | `DeviceManagementConfiguration.Read.All` | Listing Intune remediation scripts (running one uses PrivilegedOperations) |
   | `BitlockerKey.Read.All` | BitLocker recovery keys |
   | `ServiceHealth.Read.All` | Microsoft 365 service health |
   | `MailboxSettings.ReadWrite` | Out-of-office replies |
   | `Organization.Read.All` | Tenant name and domains |

   Don't click "Grant admin consent" here. Each client consents for their own tenant.
3. **Certificates & secrets → New client secret.** Put a reminder in your calendar before it expires.
4. Set these on the Haley server and restart it:

   ```bash
   HALEY_PUBLIC_URL=https://haley.example-msp.com
   HALEY_M365_CLIENT_ID=<Application (client) ID>
   HALEY_M365_CLIENT_SECRET=<client secret value>
   ```

**Password resets need a directory role.** Graph application permissions alone can't reset passwords. In each client tenant, assign Haley's enterprise app the **User Administrator** role, or **Privileged Authentication Administrator** if it should also reset admins. Haley's policy engine still sends admin accounts to a technician. Without the role, everything else works and resets fail with a clear error.

## 2. Connect a client

On the client's page in the dashboard, choose **Connect with admin consent**.

- **The client's Global Admin approves:** open the link, or copy it and send it to them. It's valid for 30 minutes. They sign in, review the permissions, and click **Accept**.
- **You approve through GDAP:** if your partner admin holds a GDAP relationship with the client that includes **Privileged Role Administrator** or **Global Administrator**, enter the client's tenant ID or `*.onmicrosoft.com` domain in the GDAP field first. The link then signs you in against the client's tenant rather than your own.

Microsoft sends the browser back to Haley. Haley then:
1. records the tenant and tests the connection (a first test can fail for a minute while consent propagates; use **Test** to retry);
2. runs **tenant discovery**: domains, licenses, users, Intune device counts, and holders of privileged Entra roles;
3. suggests settings: email domains (everything except `*.onmicrosoft.com`), the Teams tenant ID, and every admin-role holder as a **protected account**. Review them and click **Apply**.

Discovery can be re-run at any time from the integration card, including against a sandbox tenant.

## GDAP notes

GDAP (granular delegated admin privileges) controls what your technicians can do in a client tenant with their own accounts. It doesn't give Haley access by itself. Haley acts with app-only permissions, and each client still consents to your app once, as described above. GDAP just lets your partner admin give that consent without asking the client.

- Request a GDAP role that can grant app consent (**Privileged Role Administrator**, or **Cloud Application Administrator** plus the role needed for the permissions above). Keep the relationship's duration and roles as narrow as your process allows.
- Revoking Haley's access for one client doesn't touch GDAP: delete the **Haley** enterprise app in that client's tenant, or remove the integration in Haley.

## App registration per client (alternative)

If you'd rather not run a multi-tenant app, choose **Connect** in the dashboard and follow the steps shown there. Register a single-tenant app in the client's tenant with the same permissions, grant admin consent, and paste the tenant ID, client ID and secret.
