# Model protection: recommended setup

How Ordoline hosts the model (`best.onnx`) for partner websites. The protection is sized to the model's value: the
model is useful but not a major trade secret, so we stop random use and tampering cheaply, and leave the rest to the
partner contract. The general strategy (versioned URLs, baked SHA-256, publishing steps) is in the README section
[*Model storage (CDN)*](../README.md#model-storage-cdn).

## Goal

1. **Random users and websites cannot use our model.** Only partner websites can.
2. **Nobody can change the model** that partners' users run.
3. **Abuse cannot run up the bill** unnoticed.
4. **No extra work for partners**: they copy `ordoline-sorter.js` and it works, with no backend and no keys.

Not a goal: making the model file impossible to obtain. The model runs in the user's browser (that is what keeps
patients' photos on their machine), so a user of a partner site can always save it from the browser's network tab.
The partner contract covers that case.

## Recommended setup

| # | Measure | Stops | Cost |
|---|---|---|---|
| 1 | **Private S3 bucket + CloudFront** (Origin Access Control), on our own domain, e.g. `cdn.ordoline.com` | Direct bucket access and listing; being tied to one CDN address (the URL is baked into releases) | Free tier; ~30 min setup |
| 2 | **Partner domain allow-list, enforced at the edge** (CloudFront Function) | Random websites and direct downloads: they get `403` | ~$0.10 per million requests |
| 3 | **CORS limited to partner domains** (CloudFront response headers policy) | Other sites' pages reading the model (second line behind #2) | Free |
| 4 | **Versioned URLs, never overwritten** (`models/1.0.0/best.onnx`) | Breaking existing partners; stale caches | A rule |
| 5 | **SHA-256 baked into the release** (already implemented) | A swapped or corrupted model reaching users | Done |
| 6 | **Limited write access**: only a deploy role or 1–2 people can upload; MFA on all AWS accounts | The realistic attack: a stolen AWS login used to replace the model | Free |
| 7 | **S3 bucket versioning** | Accidental overwrite or delete | Pennies |
| 8 | **AWS Budgets alert** (e.g. at $20/month) | Someone downloading in a loop to run up the bill | Free |
| 9 | **Contract terms**: no extraction, reuse or redistribution of the model | Partners or their users copying it | One paragraph |

Expected running cost: about $0–5 per month.

### What the allow-list does and does not stop

| Who | Result |
|---|---|
| A partner's website (listed domain) | Works |
| A random website, even one that copied `ordoline-sorter.js` and points it at our model URL | `403` |
| Someone opening the model URL in a browser, or `curl` without tricks | `403` (no `Origin` header) |
| Someone deliberately faking the header: `curl -H "Origin: https://partner.example" …` | Gets the file |

The last row is the accepted limit: it needs intent and knowledge of a partner domain, and from there the contract
applies.

## Configuration

### Edge check (CloudFront Function, viewer request)

Browsers send the page's origin (`Origin: https://partner.example`) with the module's model download, also from its
Web Worker. Requests without a listed origin are refused before any data is sent. The partner list lives in a
CloudFront KeyValueStore (one key per origin, value unused), so adding a partner is one change, without redeploying
the function.

```js
// CloudFront Functions, runtime cloudfront-js-2.0, associated with the KeyValueStore below
import cf from "cloudfront";
const partners = cf.kvs("<KEY_VALUE_STORE_ID>");

async function handler(event) {
  const origin = event.request.headers.origin && event.request.headers.origin.value;
  if (origin && (await partners.exists(origin))) return event.request;
  return { statusCode: 403, statusDescription: "Forbidden" };
}
```

KeyValueStore keys: the exact origins, scheme included, no trailing slash, e.g. `https://clinic-partner.com`,
`https://staging.clinic-partner.com`.

### CORS and caching headers (response headers policy)

- `Access-Control-Allow-Origin`: the same partner origins (CloudFront returns the matching one per request).
- `Access-Control-Expose-Headers: ETag`: the module revalidates its cached copy by ETag.
- `Access-Control-Allow-Methods: GET, HEAD`.
- `Cache-Control: no-cache` on the object: browsers revalidate with one small request per load (see README).

The module sends a plain `GET` with no custom headers, so there is no CORS preflight (`OPTIONS`) to allow.

### Storage and access

- Bucket: *Block Public Access* on, versioning on, readable only by the CloudFront distribution (OAC bucket policy).
- Distribution: GET and HEAD only, HTTPS only, ACM certificate for `cdn.ordoline.com`.
- Write access: a deploy role (CI) or named people with MFA; nobody uses root credentials.
- Separate buckets/paths for development and production.

## Onboarding a partner

1. Add their production origin (and staging origin, for testing) to the KeyValueStore.
2. Send them the release package and the license terms.

**Testing on `localhost`:** not allowed by default, because allowing `http://localhost:8000` lets any developer
anywhere use the model. Partners test on their staging domain. If one really needs `localhost`, add it for the
integration period and remove it afterwards.

## Deliberately not done (overprotection for this model)

| Measure | Why not |
|---|---|
| Signed URLs / cookies + an Ordoline API | Partners would need a backend; per-URL caching gets harder; an authorized user still receives the file |
| License keys in `createSorter({ licenseKey })` | Development and key administration for little gain over the allow-list. Revisit if partners must be switched off without touching the CDN, or usage must be tied to contracts |
| Encrypting or obfuscating the model | The key has to reach the browser; stops nobody determined |
| User logins (Cognito) | Wrong layer: partners manage their own users |
| AWS WAF | ~$6+/month; add a rate-limit rule only if the budget alert fires |
| Server-side inference | Photos would leave the user's machine, which breaks the product's main promise |

## When to revisit

- The budget alert fires or CloudFront logs show bulk downloads → add a WAF rate limit.
- Faked-origin downloads become a real problem, or the model becomes much more valuable → license keys, then signed
  URLs.
- A partner's contract ends → remove their origins from the KeyValueStore (takes effect within minutes).
