# Old Counsel pre-order site

The page for oldcounsel.com. It is a Cloudflare Worker with static assets and a D1 database for first-party events. Nothing here is deployed. The payment link is the live Stripe link already created for this offer. The refund route calls the Stripe API when `STRIPE_REFUND_KEY` is set. This folder holds no key values.

## Run it locally

```bash
cd site
npm install
npx wrangler d1 migrations apply old-counsel-events --local
npx wrangler dev
```

The dev server listens on http://127.0.0.1:8787. `/` is the page. `/thanks?session_id=cs_test_123` is the page Stripe redirects to after payment.

`database_id` in `wrangler.jsonc` is a placeholder. Local D1 does not need a real Cloudflare database.

## Launch date

The opening year is one string, `LAUNCH_DATE` in `src/config.ts`. It is `2027`. The Worker replaces `__LAUNCH_DATE__` in the HTML, including the sheet, the FAQ, and the FAQ JSON-LD. The sentences are written for a year: "opens in 2027" and "by the end of 2027". The sentence beside the pay button on the Stripe payment link is separate and is not changed from this repo.

## What the page does

The copy follows the page spec. The example is a real reply from `google/gemini-3.6-flash` on source set F. The question and the reply are unedited. The reply is long, so the first paragraph shows and the rest opens with "Read the full reply". No words are removed.

Hero hooks: the default page, `?v=b`, and `?v=c`. The choice sticks in `localStorage` under `oc_v`. The spec also describes a `?v=` hook for an unbuilt continuity feature. It is not on the page. The page would otherwise claim something the product does not do.

Every pre-order button opens the sheet, then goes to:

```
https://buy.stripe.com/5kQ6oJakdaKugGS2SNfw404?client_reference_id=<button>_<variant>
```

`<button>` is `hero`, `example`, `offer`, or `close`. `<variant>` is `a`, `b`, or `c`. Stripe Checkout records that value on the session.

## Events

`POST /api/event` stores one event. There are no third-party trackers and no cookies. The variant stickiness uses `localStorage`. UTM parameters seen on a visit are kept in `sessionStorage` so the thanks page can still send them after Stripe redirects back in the same tab.

| Event | When |
| --- | --- |
| `page_view` | the landing page loads |
| `scroll_depth` | 25, 50, 75, and 100 percent |
| `example_view` | half the example is on screen |
| `faq_open` | a question is opened |
| `link_click` | a repo or X link is clicked |
| `cta_click` | any pre-order button |
| `door_view` | the sheet opens |
| `checkout_click` | the pay button in the sheet |
| `door_close` | the sheet is dismissed |
| `purchase_return` | `/thanks` loads, including `session_id` |
| `purchase` | Stripe `checkout.session.completed`, once the webhook secret is set |
| `refund_request` | someone submits an email on `/refund` |
| `refund_code_sent` | a code was emailed for an Old Counsel charge |
| `refund_done` | a code was accepted and the refund call finished |

`refund_request`, `refund_code_sent`, and `refund_done` are written by the Worker. `POST /api/event` does not accept them. The stored props do not include the email address. `refund_request` records `match`, `none`, or `error` so a missing code is visible in D1 without the page saying which emails have a pre-order.

`purchase_return` is the browser landing on `/thanks`. `purchase` is the webhook, which is the reliable count of paid checkouts. A refresh of `/thanks` does not send `purchase_return` again in that tab.

`GET /api/counts` returns totals per event and per event, button, and variant. It does not return session ids or the stored JSON.

```bash
curl -s http://127.0.0.1:8787/api/counts
```

The same numbers from D1, locally or, after a deploy, with `--remote`:

```bash
npx wrangler d1 execute old-counsel-events --local --json --command \
  "SELECT name, COUNT(*) AS n FROM events GROUP BY name ORDER BY name;"

npx wrangler d1 execute old-counsel-events --local --json --command \
  "SELECT name, IFNULL(cta, '') AS cta, IFNULL(variant, '') AS variant, COUNT(*) AS n FROM events GROUP BY name, cta, variant ORDER BY name, cta, variant;"
```

Willingness to pay is paid Checkout Sessions divided by unique page views. Read the paid sessions in Stripe, grouped by `client_reference_id`, for the offer `lifetime_49`. `checkout_click` divided by `cta_click` shows how many people who opened the sheet continued after the "charged today" terms.

`GET /api/counts` is open and returns only those aggregates. Remove the route before launch if the totals should not be public. The SQL above still works with Wrangler.

## Stripe webhook

`POST /api/stripe/webhook` accepts `checkout.session.completed`.

- If `STRIPE_WEBHOOK_SECRET` is unset or blank, the handler returns `{ "ok": true, "noop": true }` and stores nothing.
- If it is set, the handler checks the `Stripe-Signature` header (HMAC-SHA256 over `timestamp.payload`, five-minute tolerance) and stores a `purchase` row with the Checkout Session id and `client_reference_id`. The buyer's email is not stored. A repeated Stripe event id is acknowledged and not inserted again.

Locally, put the signing secret in `site/.dev.vars` (see `.dev.vars.example`). That file is gitignored.

```
STRIPE_WEBHOOK_SECRET=whsec_...
```

On Cloudflare, set it with `npx wrangler secret put STRIPE_WEBHOOK_SECRET`. Do not put the value in `wrangler.jsonc`.

Point the Stripe endpoint at `https://oldcounsel.com/api/stripe/webhook` and subscribe it to `checkout.session.completed`. Until the secret is set, purchases are not counted here. Stripe remains the source of payment records.

## Refunds

`/refund` refunds a buyer who asks. It does not refund anyone on a date by itself. The "end of 2027" refund in the FAQ is a separate promise.

The link "Get a refund" is on `/thanks` and in the FAQ. Both go to `/refund`.

1. The buyer enters the purchase email.
2. If that email has an Old Counsel charge, the Worker emails a 6-digit code from `noreply@oldcounsel.com`. The code expires in 15 minutes. Requests are limited to 5 an hour per email and 20 an hour per IP. Code attempts are limited to 8 per 15 minutes per email and 30 per 15 minutes per IP.
3. The page always answers "If that email has a pre-order, a code is on its way. It expires in 15 minutes." A missing purchase gets the same sentence.
4. The buyer enters the code. The Worker refunds that email's unrefunded Old Counsel charges in full.
5. The page says "Your refund is on its way. It takes 5 to 10 business days to appear."

A charge qualifies only when one of these is true:

- The Checkout Session is `complete` and `paid`, its `payment_link` is `plink_1UejbsRssDxlNdX37XKaLinq`, and the session email matches.
- The PaymentIntent metadata is `experiment=oldcounsel-fakedoor-nov2026` and `offer=lifetime_49`, and the PaymentIntent or charge email matches.

The Stripe account is shared with say.as. Anything else is not refunded. Each refund uses idempotency key `oldcounsel-refund-<payment_intent id>` and skips a charge that is already refunded.

Codes are SHA-256 hashes in D1 (`refund_codes`), peppered with `STRIPE_REFUND_KEY`. The email address is not stored. Migration `0002_refunds.sql` creates that table and the rate-limit counters.

If `STRIPE_REFUND_KEY` is unset, or the email binding has no `send` function, `/refund` does not show the form. It says to email help@oldcounsel.com.

### Stripe restricted key

Create a restricted key in the Stripe Dashboard. Name it something like `old-counsel-refunds`. Give it only:

| Resource | Permission |
| --- | --- |
| Customers | Read |
| Checkout Sessions | Read |
| Payment Intents | Read |
| Charges | Read |
| Refunds | Write |

No other write permission. Refunds Write is the only write. The key starts with `rk_live_` or `rk_test_`. Set it with `npx wrangler secret put STRIPE_REFUND_KEY`. Do not put it in `wrangler.jsonc`. Rotating the key invalidates codes that have not expired yet.

The Worker reads customers by email, Checkout Sessions for that payment link, and PaymentIntents. It expands `latest_charge` and `customer` before refunding, and posts `POST /v1/refunds` with `payment_intent` and `reason=requested_by_customer`.

### Email

The Worker sends the code with the `EMAIL` binding (`send_email` in `wrangler.jsonc`), from `noreply@oldcounsel.com`, plain text, subject "Your refund code". The binding allows that sender only.

Before a live send, onboard the domain to Cloudflare Email Sending. This repo does not run that command.

```bash
npx wrangler email sending enable oldcounsel.com
```

Add the SPF and DKIM records that command prints. The domain is already on Cloudflare, so those records belong on the oldcounsel.com zone. `wrangler dev` simulates the binding and does not send mail. Do not set `"remote": true` on the binding unless you mean to send real email from your laptop.

## Deploy

Do this only when the site should actually go live. oldcounsel.com is already on Cloudflare. `wrangler.jsonc` routes this Worker to that hostname as a custom domain, so deploy attaches it. This repo does not run the deploy.

1. `cd site && npm install`
2. `npx wrangler login` with the account that holds oldcounsel.com
3. `npx wrangler d1 create old-counsel-events`
4. Replace the placeholder `database_id` in `wrangler.jsonc` with the id that command prints.
5. `npx wrangler d1 migrations apply old-counsel-events --remote`
6. `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
7. `npx wrangler secret put STRIPE_REFUND_KEY` with the restricted key described above
8. `npx wrangler email sending enable oldcounsel.com`, then add the SPF and DKIM records it prints
9. `npx wrangler deploy`

The route already in the config is:

```jsonc
"routes": [
  { "pattern": "oldcounsel.com", "custom_domain": true }
]
```

Optional: set `"account_id"` in `wrangler.jsonc` to the account Wrangler should use. Leave it out to use the account from `wrangler login`.

`npm run types` regenerates `worker-configuration.d.ts` after a binding change. `npm run check` typechecks the Worker.

Logs and traces are enabled at a sampling rate of 1, which fits a page with well under a thousand visits a week. Lower `observability.traces.head_sampling_rate` if that volume grows.
