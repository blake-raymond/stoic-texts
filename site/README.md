# Old Counsel site

The site for oldcounsel.com. It is a Cloudflare Worker with static assets, a chat page, and a D1 database. Nothing here is deployed from this repository. Checkout Sessions are created by the Worker from Stripe price ids in the environment. The refund route refunds one-time charges. The `/thanks` page grants access when `STRIPE_REFUND_KEY` is set. This folder holds no key values.

## Run it locally

```bash
cd site
npm install
npm run migrate:local
npm run dev
```

`npm run dev` rebuilds the system prompt, builds the chat page, and starts Wrangler. The dev server listens on http://127.0.0.1:8787. `/` is the landing page. `/chat` is the conversation. `/thanks?session_id=cs_test_123` is the page Stripe redirects to after payment.

`database_id` in `wrangler.jsonc` is the existing empty D1 database `old-counsel-events` (`92147965-54f1-4d4d-b8a3-3cb75e65d9e3`). Do not create a second database. Local D1 is separate from that remote database. Remote migrations are a manual step, described under Deploy.

Chat needs `OPENROUTER_API_KEY` and `ACCESS_SIGNING_SECRET` (at least 16 characters) in `site/.dev.vars`. See `.dev.vars.example`. Point `OPENROUTER_API_BASE` and `STRIPE_API_BASE` at a local mock when you do not want live calls.

## What the page does

The example is a real reply from the eval on source set F. The question and the reply are unedited. The reply is long, so the first paragraph shows and the rest opens with "Read the full reply". No words are removed. `prompt/meta.json` still records that eval (`google/gemini-3.6-flash`, o200k tokens). The live chat model is `CHAT_MODEL` in `src/config.ts`.

Hero hooks: the default page, `?v=b`, and `?v=c`. The choice sticks in `localStorage` under `oc_v`.

"Start a conversation" goes to `/chat`. "Get lifetime access" opens the sheet, then goes to:

```
https://buy.stripe.com/5kQ6oJakdaKugGS2SNfw404?client_reference_id=<button>_<variant>
```

The chat paywall uses `chat`. `<variant>` is `a`, `b`, or `c`. Stripe Checkout stores the anonymous id as `client_reference_id`.

## Chat

`/chat` is a Vite build of assistant-ui, written to `site/public/chat/` (gitignored) and served by the Worker. The conversation is kept in `localStorage`. The server counts replies and does not store the text.

`FREE_CONVERSATION_REPLIES` in `src/config.ts` is 8: one sitting on one trouble. After that, the server returns `free_limit` and the page offers one plan, $19 a month or $180 a year. A paid buyer, including a founding lifetime, is capped at `MONTHLY_REPLY_CAP` (100) replies per UTC month. Both caps are enforced in D1. The founding lifetime is $249, capped at `FOUNDING_BUYER_CAP` (100) paid buyers.

The model, temperature, and OpenRouter provider pin are `CHAT_MODEL`, `CHAT_TEMPERATURE`, and `OPENROUTER_PROVIDER` in that same file. The system prompt is the byte-identical prefix from `scripts/build_prompt.py`, with `cache_control: { type: "ephemeral", ttl: "1h" }` on the system block. A cold cache re-bills the whole prompt at the 1-hour write price, which is 2x input. The daily spend guard defaults to $50 (`DAILY_SPEND_LIMIT_USD` overrides it) and holds $1.40 per reply until OpenRouter reports the real cost. Each reply log includes `cached_tokens` and `cache_write_tokens`.

Returning on another device: if the email binding can send and `ACCESS_SIGNING_SECRET` is set, `/api/access/restore` emails a 6-digit code. Otherwise the page says to email help@oldcounsel.com. Cloudflare Email Sending is not available on the Workers free plan, so a production deploy on that plan uses the help@ sentence.

## Events

`POST /api/event` stores one event. There are no third-party trackers. The variant stickiness uses `localStorage`. Access uses two first-party httpOnly cookies, `oc_anon` and `oc_access`. UTM parameters seen on a visit are kept in `sessionStorage` so the thanks page can still send them after Stripe redirects back in the same tab. `/chat` also sends `page_view`.

| Event | When |
| --- | --- |
| `page_view` | the landing page loads |
| `scroll_depth` | 25, 50, 75, and 100 percent |
| `example_view` | half the example is on screen |
| `faq_open` | a question is opened |
| `link_click` | a repo or X link is clicked |
| `cta_click` | a landing button, including one that goes to `/chat` |
| `door_view` | the sheet opens |
| `checkout_click` | the pay button in the sheet |
| `door_close` | the sheet is dismissed |
| `purchase_return` | `/thanks` loads, including `session_id` |
| `purchase` | Stripe `checkout.session.completed`, once the webhook secret is set |
| `refund_request` | someone submits an email on `/refund` |
| `refund_code_sent` | a code was emailed for an Old Counsel charge |
| `refund_done` | a code was accepted and the refund call finished |

`refund_request`, `refund_code_sent`, and `refund_done` are written by the Worker. `POST /api/event` does not accept them. The stored props do not include the email address. `refund_request` records `match`, `none`, or `error` so a missing code is visible in D1 without the page saying which emails have a purchase.

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

Willingness to pay is paid Checkout Sessions divided by unique page views. `client_reference_id` is the anonymous id. Session metadata `offer` is `subscription` or `founding_249`.

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

`/refund` refunds a one-time purchase: the retired $49 payment link, and a founding lifetime when `STRIPE_PRICE_FOUNDING` is set. Subscription refunds are not handled.

The link "Get a refund" is on `/thanks` and in the FAQ. Both go to `/refund`.

1. The buyer enters the purchase email.
2. If that email has an Old Counsel charge, the Worker emails a 6-digit code from `noreply@oldcounsel.com`. The code expires in 15 minutes. Requests are limited to 5 an hour per email and 20 an hour per IP. Code attempts are limited to 8 per 15 minutes per email and 30 per 15 minutes per IP.
3. The page always answers "If that email has a purchase, a code is on its way. It expires in 15 minutes." A missing purchase gets the same sentence.
4. The buyer enters the code. The Worker refunds that email's unrefunded Old Counsel charges in full.
5. The page says "Your refund is on its way. It takes 5 to 10 business days to appear."

A charge qualifies only when one of these is true:

- The Checkout Session is `complete` and `paid`, its `payment_link` is `plink_1UejbsRssDxlNdX37XKaLinq`, and the session email matches.
- The PaymentIntent metadata is `experiment=oldcounsel-fakedoor-nov2026` and `offer=lifetime_49`, and the PaymentIntent or charge email matches.

The Stripe account is shared with say.as. Anything else is not refunded. Each refund uses idempotency key `oldcounsel-refund-<payment_intent id>` and skips a charge that is already refunded.

Codes are SHA-256 hashes in D1 (`refund_codes`), peppered with `STRIPE_REFUND_KEY`. The email address is not stored. Migration `0002_refunds.sql` creates that table and the rate-limit counters.

If `STRIPE_REFUND_KEY` is unset, or the email binding has no `send` function, `/refund` does not show the form. It says to email help@oldcounsel.com.

### Stripe restricted key

Create a restricted key in the Stripe Dashboard. Name it something like `old-counsel-billing`. Give it:

| Resource | Permission |
| --- | --- |
| Customers | Read |
| Checkout Sessions | Write |
| Payment Intents | Read |
| Charges | Read |
| Refunds | Write |
| Billing portal sessions | Write |

The key starts with `rk_live_` or `rk_test_`. Set it with `npx wrangler secret put STRIPE_REFUND_KEY`. Do not put it in `wrangler.jsonc`. Rotating the key invalidates codes that have not expired yet.

The Worker creates Checkout Sessions, reads customers by email, and reads Payment Intents. It expands `latest_charge` and `customer` before refunding a one-time charge, and posts `POST /v1/refunds` with `payment_intent` and `reason=requested_by_customer`. Subscription refunds are not handled. A founding sale past the 100-buyer cap is refunded with the same call.

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
3. The D1 database already exists. `database_id` is already `92147965-54f1-4d4d-b8a3-3cb75e65d9e3`. Do not create another one.
4. `npx wrangler d1 migrations apply old-counsel-events --remote` (0001 through 0004). This repo does not apply remote migrations.
5. In Stripe, create the product and prices named in the pull request. Then `npx wrangler secret put STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, and `STRIPE_PRICE_FOUNDING`. Leave the founding price unset to hide that offer.
6. Configure the Customer Portal (cancel, switch monthly and yearly, update card). Then `npx wrangler secret put STRIPE_PORTAL_ENABLED` with the value `1`. Until that is set, "Cancel any time" stays hidden.
7. `npx wrangler secret put OPENROUTER_API_KEY`
8. `npx wrangler secret put ACCESS_SIGNING_SECRET` (for example `openssl rand -base64 32`). Rotating it logs everyone out.
9. `npx wrangler secret put STRIPE_REFUND_KEY` with the restricted key described above. The same key creates Checkout Sessions, opens the billing portal, and reads Checkout Sessions for `/thanks`.
10. `npx wrangler secret put STRIPE_WEBHOOK_SECRET`. Point the webhook at `https://oldcounsel.com/api/stripe/webhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`.
11. `python3 ../scripts/build_prompt.py` and `npm run build:web` before deploy, so the prompt and `/chat` are in the bundle. `npm run dev` does both.
12. `npx wrangler deploy` only when the site should actually go live.

Optional vars, left unset so the code defaults apply: `DAILY_SPEND_LIMIT_USD` (50), `CHAT_RATE_ANON_PER_HOUR` (30), `CHAT_RATE_IP_PER_HOUR` (60).

If deploy rejects the `send_email` binding on the free plan, remove that block. Refunds and restore then show the help@oldcounsel.com sentence. Do not set `"remote": true` on the binding.

The route already in the config is:

```jsonc
"routes": [
  { "pattern": "oldcounsel.com", "custom_domain": true }
]
```

Optional: set `"account_id"` in `wrangler.jsonc` to the account Wrangler should use. Leave it out to use the account from `wrangler login`.

`npm run types` regenerates `worker-configuration.d.ts` after a binding change. `npm run check` typechecks the Worker and the chat page.

Logs and traces are enabled at a sampling rate of 1, which fits a page with well under a thousand visits a week. Lower `observability.traces.head_sampling_rate` if that volume grows.
