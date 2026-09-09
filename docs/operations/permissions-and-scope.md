# Permissions, project scope and release inputs

This document describes the implemented contract. It is not permission to change
production, connect real accounts, send publications, rotate secrets or deploy.

## Product surface

The authenticated release surface includes projects and invitations, onboarding,
Telegram and supported VK operations, Calendar, Composer, editorial approval,
publication history and analytics, settings, Today, AI/Studio, Autopilot, trends,
reconnaissance, opportunities, site analysis, growth, knowledge, legal visuals and
video, Sites with hosted/WordPress destinations, and global administration.
`src/lib/release-scope.ts` is the machine-readable route/capability boundary.
The preview flag applies to legacy public design variants; it must not hide
authenticated sections to make acceptance checks pass.

Being inside release scope does not grant provider credentials or imply every
provider operation is implemented. `src/lib/provider-capabilities.mjs` records
operation/media support. Telegram supports its listed publication operations; VK's
current publication payload is text. RSS is a source. YouTube/Instagram OAuth
remains unavailable until Composer supports their publication payloads. TenChat
has an export path and requires separately confirmed official access for live
publication. This remediation does not enable or disable those capabilities.

## Project roles

The shared policy in `src/lib/project-role-policy.mjs` is used by the web process
and workers. Every decision also requires an active membership in a non-archived
project. Role names in a browser response, cookie or old queued payload are not
authoritative.

| Permission | Owner | Author | Approver | Publisher |
| --- | --- | --- | --- | --- |
| Read project | Yes | Yes | Yes | Yes |
| Manage project and members | Yes | No | No | No |
| Create/edit/submit content | Yes | Yes | Yes | No |
| Review/approve content | Yes | No | Yes | No |
| Publish content | Yes | No | No | Yes |
| Send audience replies | Yes | No | Yes | Yes |
| Read project audit | Yes | No | No | No |

An approval remains bound to its exact revision and content hash. Publication
permission alone does not authorize generating or editing AI content. Read-only
AI/Studio and video/visual views require project read access; paid generation
requires the corresponding content operation. Sites content creation/review/
publication follows the same operation permissions. Configuring a CMS destination
or social connection requires `project.manage`.

## Tab and request identity

The selected project is stored per tab in sessionStorage under
`aurora:request-project-id`. Browser API callers use `projectFetch`; it captures
`X-Aurora-Project-Id` before sending the request. The server checks this explicit
project against current membership and the target resource's project. A malformed,
conflicting or revoked selector fails closed instead of falling back to the
account's other project. Delayed responses from a previous selection are discarded.

The account-level selected-project preference remains a bootstrap/default for
explicit server or legacy callers. It is not the source of truth for a tab that
already selected a project. Project creation, switching and accepted invitations
update the tab identity; project changes remount project-owned UI state.

Native images, video, downloads and full-navigation links cannot add the fetch
header. Their recognized project routes use `projectNativeUrl` with an explicit
`projectId` query parameter. `nativeRequestProjectId` accepts one positive selector,
rejects duplicate/conflicting query/header values and does not use the account
preference. This includes media assets, project exports, site reports, production
briefs and OAuth start. Account avatar assets are account-owned; public hosted
site pages are intentionally public. Do not append project IDs to external URLs.

When maintaining a new native project route, register its local URL in the helper,
apply the common server permission guard to its explicit selector and add a
cross-project/revocation test. Streamed media/export paths recheck access as defined
by their guards; already delivered bytes cannot be recalled after revocation.

## Social ownership and OAuth

VK resolves the community from the supplied credential; a browser-supplied group
or project cannot replace that result or the authenticated project selector. The
provider check runs before the database transaction. Admission then uses the shared
selected-project permission transaction, locking the current user, membership and
project through the channel, health and event writes. A committed revocation,
project archive or user block prevents those writes. If an authorized write already
holds the locks, revocation waits for it; the next admission is denied. A changed
legacy default project during provider validation also fails closed.

Reconnecting an existing VK channel encrypts the new credential with the persisted
`channels.user_id` and provider as authenticated context, matching the worker's
decryption contract. The current manager remains the audit-event actor; reconnect
does not transfer channel ownership. A new channel uses its connecting user's ID.
Channel mutation, health transition and event insertion commit or roll back
together. This change has no schema migration or automatic credential backfill.

Before a separately authorized rollout, inventory existing VK connections in the
approved private execution context. A read-only transaction may report channel,
project and stored owner IDs, active state and credential presence; these metadata
alone do not establish whether ciphertext is decryptable. An authorized diagnostic
with the existing keyring must use the worker's exact stored-owner/provider context
and report only counts and affected IDs with an error category. Do not export raw
ciphertext, decrypted tokens, keys or arbitrary exception messages. Missing keys
must remain distinct from an authentication failure; neither establishes who
actually owns a community.

For a confirmed incompatible legacy credential, record the exact project/channel
and use an explicitly authorized current project manager's Settings reconnect flow
with a valid credential for that same community. Verify the stored owner is
unchanged, the event names the acting manager, and worker-context decryption succeeds
without publishing. Separately authorize any live publication test. Do not guess a
different `user_id`, rewrite old payloads, try other users' contexts or rotate keys
as a repair. `scripts/reencrypt-token-envelopes.mjs` mutates stored credentials and
has no dry-run mode; it is not a read-only inventory tool.

Telegram requires the linked private actor, current human and bot posting rights,
and a short-lived one-use proof bound to actor/user/project/channel. Existing
connections are not automatically reassigned or bulk reverified. Follow
[Telegram channel ownership](telegram-channel-ownership.md) for the safe inventory,
confirmation journey, timeout/error handling and sandbox acceptance.

OAuth start validates explicit project management permission before redirecting.
Its ten-minute state uses the existing AES-GCM token keyring and binds state, PKCE
verifier, network, user and project. Callback does not read the account's shared
project preference. It checks current management permission before code exchange,
locks membership/project rows and checks permission again before writing. Existing
channel lookup/update is project-scoped; the active provider-account uniqueness
constraint still prevents moving another project's active connection implicitly.

The callback clears the browser state cookie; the provider consumes the OAuth code.
There is no claim of a new server-side durable OAuth receipt ledger. Old editable
JSON state cookies are rejected, so flows already in progress at rollout must be
started again. On successful return, Settings selects the captured project through
the existing authorized project switch before showing success or refreshing its
channels. Missing/revoked return context does not show a success notice for the
currently visible unrelated project.

## Global administration

A project owner is not automatically a global administrator. Administration uses
the server allowlist `AURORA_ADMIN_USER_IDS` or `AURORA_ADMIN_EMAILS`. The email path
requires `users.verified_email = users.email`, exposed as a verified session flag.
Typing an allowlisted address into a profile is insufficient. The explicit user-ID
allowlist remains supported. Admin alert recipients use the same verified-email
condition and exclude blocked users and users without a linked notification chat.

Do not backfill email verification from a matching string or provider display data.
Use the implemented identity proof flow or an explicitly authorized operator
decision for the user-ID allowlist. Cross-project admin views must retain the admin
guard independently of all project permission checks.

## Rollout inputs and external acceptance

Before a separately authorized rollout, prepare the following reviewable inputs:

- Exact candidate commit/build digest and its complete migration manifest. The new
  Telegram ownership migration creates the baseline `bot_links` table when an
  accepted legacy installation lacks it; historical migration hashes are unchanged.
  No ownership or email-verification backfill is implied.
- Coordinated web/worker assets and a fresh browser reload. Old native URLs without
  a project selector now fail closed; clients must use the updated URL helper.
- Read-only inventory of existing Telegram bindings, an identified owner for each
  confirmation, and a separately authorized sandbox Telegram account/channel.
- Server-owned HTTPS `APP_URL`, OAuth callback registrations where a provider is
  actually supported, and existing token keyring configuration. Never print or
  invent secret values. State-key changes can invalidate in-flight OAuth attempts.
- Verified administration identities and the actual configured allowlist. Existing
  unverified email matches may lose admin/alert access until proof is established.
- For WordPress: an authorized HTTPS sandbox destination with current publishing
  rights, DNS/network access and credentials supplied through the existing secure
  flow. Lost acknowledgements must retain uncertainty and successful destination
  receipts; absence of a receipt is not proof of absence of a publication.
- Measured queue/AI/media capacity, restore evidence and an owner decision on budgets,
  service objectives, RPO/RTO and alert recipients. Local measurements do not create
  agreed production targets. Follow the restore quarantine procedure before enabling
  any restored external-send queue.

Live provider behavior, real backup availability, legal details and production
infrastructure readiness must be evidenced separately. Missing external inputs are
verification limitations, not successful acceptance and not permission to exclude
the affected release feature.
