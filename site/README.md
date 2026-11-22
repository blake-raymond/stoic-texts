# Old Counsel pre-order site

The page for oldcounsel.com. It is a Cloudflare Worker with static assets and a D1 database for first-party events. Nothing here is deployed. The payment link is the live Stripe link already created for this offer. This folder does not call Stripe, and it holds no keys.

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

The opening date is one string, `LAUNCH_DATE` in `src/config.ts`. It is still `[LAUNCH DATE]`. The Worker replaces `__LAUNCH_DATE__` in the HTML, including the sheet, the FAQ, and the FAQ JSON-LD. Change that constant when a date is chosen. The sentence beside the pay button on the Stripe payment link has the same placeholder, and Stripe has to be updated separately.

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

## Deploy

Do this only when the site should actually go live. Registering oldcounsel.com is separate, and this repo does not do it.

1. `cd site && npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create old-counsel-events`
4. Replace the placeholder `database_id` in `wrangler.jsonc` with the id that command prints.
5. `npx wrangler d1 migrations apply old-counsel-events --remote`
6. `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
7. `npx wrangler deploy`

Deploy publishes a `*.workers.dev` hostname. Attach oldcounsel.com only after the domain is on the same Cloudflare account. Add this to `wrangler.jsonc` and deploy again:

```jsonc
"routes": [
  { "pattern": "oldcounsel.com", "custom_domain": true },
  { "pattern": "www.oldcounsel.com", "custom_domain": true }
]
```

Optional: set `"account_id"` in `wrangler.jsonc` to the account Wrangler should use. Leave it out to use the account from `wrangler login`.

`npm run types` regenerates `worker-configuration.d.ts` after a binding change. `npm run check` typechecks the Worker.

Logs and traces are enabled at a sampling rate of 1, which fits a page with well under a thousand visits a week. Lower `observability.traces.head_sampling_rate` if that volume grows.
