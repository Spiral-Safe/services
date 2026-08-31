# Accounts, API keys, usage, and billing

This layer turns the signing adapter into a multi-account service. Production
uses PostgreSQL, Stripe Checkout/Customer Portal for the base subscription, and
Metronome as the sole usage-rating path. The in-memory implementation is an
injectable development/test fixture; it is rejected outside explicit
development mode.

## Trust and data flow

1. A developer signs into the account console and creates a scoped API key.
   The full `ssk_live_...` value is returned once. PostgreSQL stores only an
   HMAC-SHA-256 digest, a non-secret prefix, scopes, and username allowlist.
2. API-key authentication resolves the server-side account and tenant. The
   caller cannot select another tenant, account, role, or allowed username.
3. A billable request reserves a unique usage row before calling Vault. A
   successful Vault response commits it and creates a durable outbox record; a
   failed Vault response cancels a newly created reservation.
4. The asynchronous exporter submits committed records to Metronome. Signing
   never waits for Metronome. Metronome rates the configured contract and, only
   after its Stripe invoicing integration is provisioned, creates the usage
   invoice in Stripe.

`GET /readyz` checks both Vault and PostgreSQL when billing is enabled. A pod
with a failed billing database is therefore removed from ready endpoints.

## Production bootstrap

Start from [`.env.billing.example`](../.env.billing.example). Its checked-in
Metronome verification flag is intentionally `false`, so a copied production
configuration fails closed until the operator completes the invoice proof and
changes it deliberately. Apply the schema
before starting the service:

```sh
DATABASE_URL='postgresql://...' DATABASE_SSL=true npm run billing:migrate
```

The migration is idempotent and takes a PostgreSQL advisory transaction lock so
rolling replicas do not race. Run it with a database role allowed to create and
alter these tables; run the service with a narrower data role. Configure HA,
encrypted backups, point-in-time recovery, connection limits, and certificate
trust for PostgreSQL. Production explicitly rejects `DATABASE_SSL=false`.
The verified-Metronome-alias column is deliberately nullable for migration from
older schemas; an older attestation has no alias snapshot and therefore fails
closed until an administrator re-attests the full mapping.

Non-development `BILLING_MODE=postgres` will not start unless all of these are
present:

- a PostgreSQL URL, API-key pepper, console-session secret, and exact HTTPS
  console origin;
- operator-defined plans with limits, estimate amounts, a distinct Stripe
  Product and base Price, and distinct Metronome Product and rate-card IDs;
- a Stripe restricted key, webhook signing secret, hosted Checkout URLs, and
  Portal return URL;
- a Metronome token plus
  `METRONOME_STRIPE_INVOICING_VERIFIED=true`.

The `sandbox`, `launch`, and `scale` plans exist only in seeded memory mode.
Their zero amounts are demo fixtures and are not production prices. In a
production plan, `walletUnitAmount` and `transactionUnitAmount` are clearly
labeled dashboard estimates in the chosen currency's minor unit. Metronome's
rate card and contract remain authoritative.

## Stripe base subscription

The instantiated `stripe` 22.4.0 client pins API version
`2026-07-29.dahlia`. Checkout creates a hosted subscription session containing
exactly one operator-configured base Price. It intentionally does not set
`payment_method_types` or `automatic_tax`. Existing subscriptions are managed
through the hosted Customer Portal; Checkout refuses to create a parallel base
subscription.

The server, not the browser, chooses Checkout's idempotency key. It is scoped to
the account and `STRIPE_CHECKOUT_INTENT_VERSION`, while the required eight-letter
integration suffix is deterministically derived from the same intent. A retry
therefore sends byte-equivalent parameters. Selecting another plan while that
intent is live fails at Stripe's idempotency boundary rather than opening a
second session.

Checkout sessions can expire. To recover without enabling duplicates, first
verify every session created with the current intent version is expired and no
subscription was created, record that operational decision, then increment
`STRIPE_CHECKOUT_INTENT_VERSION`. Never bump it merely because a user refreshed
the dashboard. Accounts with an existing subscription remain Portal-only. A
terminal canceled/incomplete-expired subscription is conditionally cleared by
the verified webhook flow so that account can renew.

Register `POST /billing/stripe/webhook` in Stripe. The raw-body route is
registered before JSON parsing and verifies `Stripe-Signature` with the
`whsec_...` secret. Event IDs are atomically claimed and persisted. Invalid
signatures return 400; concurrent or transient processing failures return
503/500 so Stripe retries. Subscription events are not trusted for ordering:
the handler retrieves current subscription state from Stripe, ignores a stale
different subscription ID, requires exactly one subscription item whose current
Price maps to exactly one local plan, and derives the account period from its
validated item bounds. Portal price changes therefore select the tier by Stripe
Price rather than stale metadata; unmapped or ambiguous Prices fail for retry.

Grant the restricted key only the Checkout Session, Customer Portal Session,
Customer, and Subscription operations used here. Test the exact restricted-key
permissions in Stripe test mode before production.

### Tax launch blocker

This repository deliberately does not guess tax behavior and does not enable
Checkout `automatic_tax`. Do not launch paid plans until the operator has
determined registrations, product tax codes, customer location evidence, and
the responsible tax provider. When Metronome creates Stripe usage invoices,
configure and test its supported tax-provider flow as part of the Metronome to
Stripe integration. A successful tax-inclusive sandbox invoice and failure
alert should be a release gate.

## Metronome to Stripe usage invoicing

The outbox sends batches of 1-100 records to
`POST https://api.metronome.com/v1/ingest`. Each record contains a durable
transaction ID, the attested ingest-alias snapshot as `customer_id` (or the
current alias only in development before any attestation), an RFC3339 timestamp,
event type, and string-valued properties. Event types are:

- `spiral_active_wallet`
- `spiral_transaction_signed`

Properties include the quantity and the plan's configured Metronome Product and
rate-card IDs. The transaction ID is stable, so Metronome's deduplication and
the local outbox both protect retries. Network failures, 429, and 5xx responses
retry with bounded exponential backoff. Other 4xx responses are dead-lettered
for operator action. Pending/dead-letter counts appear in the admin console.

Ingest alone does **not** create a charge. Before setting the global verification
flag, complete this provisioning in both sandbox and production:

1. Connect the intended Stripe account in Metronome.
2. Configure the two event types and Product IDs on the plan's rate card.
3. Create the Metronome customer with the exact `metronomeCustomerId` ingest
   alias from the protected admin analytics API or the account-provisioning
   record. The server-rendered account view deliberately does not echo provider
   identifiers into HTML or recordings.
4. Set that customer's Stripe billing-provider configuration to the same
   `stripeCustomerId` recorded by the Checkout webhook.
5. Attach the configured rate card through an active Metronome contract and
   select the Stripe billing-provider configuration for that contract.
6. Map Metronome products to the intended Stripe invoice-line entities, run
   events through sandbox, finalize an invoice, and verify collection and error
   alerts end to end.
7. In the Spiral Safe admin account view, independently enter the exact Stripe
   customer ID, Metronome customer ingest alias, and Metronome rate-card ID.
   The form also submits the visible read-only local plan ID from the page that
   the operator reviewed. The store atomically compares that complete tuple
   with current protected account/plan state while recording the assertion, so
   a concurrent webhook or plan change cannot attest a different mapping. The
   attestation snapshots the current Stripe customer, Metronome ingest alias,
   local plan, and Metronome rate card. A customer-alias, Stripe-customer, plan,
   rate-card, or terminal-subscription change makes it non-current and signing
   fails closed until re-provisioned.

The service returns `402 billing_provisioning_required` for an otherwise active
account until step 7 is recorded. That attestation is an operator assertion, not
a remote Metronome audit; production operations must reconcile it against
Metronome. See Metronome's official
[Stripe invoicing guide](https://docs.metronome.com/integrations/invoice-integrations/stripe)
and [customer creation API](https://docs.metronome.com/api-reference/customers/create-a-customer)
for the provider-configuration payload.

## Metering, idempotency, and quotas

An active-wallet unit means the first successful wallet action in an account's
billing period. `/create`, `/check`, and `/signin` reserve the unit using
`account + period start + HMAC-SHA-256(tenant, username, chain)`, using the
billing pepper and a wallet-specific domain separator. The clear username is
never stored in usage tables or sent to Metronome, and the opaque value is not
an unkeyed username dictionary target. Existing wallets are counted again when
first used after a period rollover, without being re-created.

Each successful transaction `/complete` consumes one transaction unit. Message
signatures, including Ethereum EIP-191, consume no transaction units. The
service reserves transaction quota before calling Vault, sends the requested
operation with the completion, and releases output only when Vault returns the
same operation from its stored one-time ceremony. The Vault plugin itself burns
and rejects a request whose operation differs from that stored ceremony before
credential validation or signing. As defense in depth, a successful Vault
response with a missing or different operation returns
`502 vault_operation_mismatch`, cancels a newly created reservation, and never
exposes the signature or encoded transaction. The transaction ceremony's
single-use Vault `ceremonyId` is also the account-local usage idempotency key. A
duplicate while the first request is still reserved returns
`409 usage_in_progress` before a second Vault call. A retry of committed usage
cannot create another outbox record. Vault's ceremony replay protection remains
the signing boundary.

Reservations count toward quota to prevent concurrent oversubscription. If
Vault succeeds but committing usage fails, the reservation is deliberately
left intact and the request fails; it is not canceled as though Vault had
failed. A reserved row older than `BILLING_RESERVATION_TTL_MS` (five minutes by
default, with an enforced one-minute to one-hour range) is deleted before quota/idempotency evaluation and is never
automatically charged: after a process crash, the service cannot know whether
Vault completed.
This fail-safe creates an unavoidable underbilling window if Vault succeeded but
the process died before `commitUsage`. Reconcile Vault/account audit evidence
against usage/outbox records; do not convert stale reservations into charges
without a separate reviewed reconciliation process.

Inactive/suspended subscriptions and unverified usage-invoicing mappings return
HTTP 402. Exhausted plan quotas return HTTP 429 with a stable
`quota_exceeded` error. Local per-process request limiting is separate and must
be backed by an ingress/global limiter in a multi-replica production deployment.

## Consoles and secrets

Developer and admin sessions use random server-side session IDs, an HttpOnly
`SameSite=Strict` cookie, and `Secure` outside memory development mode. Login is
bounded by IP+email and performs password verification work even for an unknown
email. Session-authenticated mutations require both a per-session CSRF token and
the exact configured `Origin`. Admin roles come only from stored server-side
users; developer account IDs come only from the stored session.

After the migration, create or rotate the first production admin from an
operator shell with a mounted password file. The CLI rejects password arguments
and does not print the secret:

```sh
DATABASE_URL='postgresql://...' DATABASE_SSL=true \
  npm run billing:bootstrap-admin -- \
  --email admin@example.com --password-file /run/secrets/spiral_admin_password
```

The bootstrap operation can update only an account-independent admin row; it
will not promote a developer email. Protect the database credentials and
password file with the platform secret manager and delete or unmount the file
when bootstrap is complete.

The admin can create an account and its first developer atomically, inspect
per-account/current-period/daily usage, review delivery counts, and attest a
Metronome mapping. The developer can create/revoke scoped API keys, see plan
limits and clearly labeled charge estimates, open Checkout once, and use the
Portal. API-key secrets appear on one response only. Do not record that response
in screenshots, traces, access logs, support tickets, or analytics.

Temporary developer passwords currently have no forced-reset flag or password
change flow, and the console does not yet provide OIDC or MFA. Until those are
implemented, provision developer credentials through a secure channel, rotate
them operationally, and treat this as a release blocker for public self-service
onboarding. The signing ceremony still requires WebAuthn; that does not replace
strong authentication for the billing/admin console.

For a deterministic local fixture only, set `SERVICE_DEV_MODE=true`,
`BILLING_MODE=memory`, and `BILLING_DEMO_SEED=true`. Default credentials are
`developer@example.test` / `demo-developer-only` and
`admin@example.test` / `demo-admin-only`; override the `DEMO_*` variables when
sharing a development machine. Memory mode and seeded credentials are rejected
in production.
