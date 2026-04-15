# Deploy runbook: Internal API token rollout

Coordinated rollout for PR [santhoshnarayan/stripev2#2](https://github.com/santhoshnarayan/StripeV2/pull/2): fix Vercel preview backend access and gate the backend with a shared-secret header.

## Why this needs ordering

The backend's token gate is **off when `INTERNAL_API_TOKEN` is unset** and **on when it's set** — see `apps/server/src/index.ts:49-61`. That gives us a zero-downtime rollout as long as you follow the order below:

1. Ship the backend code with the middleware **inert** (env var unset) — no behavior change
2. Ship the new frontend that sends the token on every proxied request — backend still accepting both tokened + un-tokened calls
3. Turn on the backend gate by setting the env var — every in-flight request from the new FE already carries the token

If you reverse 1 and 3, production dies: the backend starts 401-ing every request from the old FE.

**Stale-tab caveat**: at step 3, any browser tab still running the *previous* FE bundle will start hitting 401s and needs a refresh. That's unavoidable with a shared-secret cutover; the blast radius is minutes, not hours.

## Targets

| Host | Variable | Value | Scopes |
|---|---|---|---|
| Vercel | `API_URL` | `https://stripev2-production-723a.up.railway.app` | Production + Preview |
| Vercel | `INTERNAL_API_TOKEN` | `<token>` | Production + Preview |
| Railway | `INTERNAL_API_TOKEN` | `<token>` | default |

Also plan to **delete** `NEXT_PUBLIC_API_URL` from Vercel — it's no longer read anywhere. Safe to do any time after step 2.

> **Token storage**: the 256-bit hex token was generated during the PR rollout session. It is NOT committed to this repo. Retrieve it from wherever you stashed it (1Password / session context) before running the commands below, and treat it as a production secret.

## Prerequisites

- `railway` CLI authed to the StripeV2 project, or Railway dashboard access
- `vercel` CLI authed (`VERCEL_TOKEN` exported) or Vercel dashboard access
- `gh` or GitHub UI access to merge the PR
- A terminal with the token in an env var to avoid pasting it into shell history:
  ```bash
  read -rs INTERNAL_API_TOKEN   # paste, then Enter
  export INTERNAL_API_TOKEN
  ```

---

## Step 1 — Merge PR and let Railway ship the backend (inert)

```bash
gh pr merge 2 --squash
```

Railway auto-deploys on master push (per `railway.json` watchPatterns). **Do not set `INTERNAL_API_TOKEN` on Railway yet.** The new middleware is present but a no-op while the env var is unset.

Verify:

```bash
# Health stays open
curl -sS https://stripev2-production-723a.up.railway.app/health
# → {"status":"ok"}

# Without a token — gate is inert, should be whatever it was before (not 401)
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://stripev2-production-723a.up.railway.app/api/auth/session
# → 200 (or 401 from Better Auth's own logic, but NOT 401 from the gate)
```

If production is still healthy, move on.

---

## Step 2 — Ship the new frontend on Vercel

Set the new vars (all scoped to Production **and** Preview — this is the bug fix):

```bash
echo 'https://stripev2-production-723a.up.railway.app' \
  | vercel env add API_URL production
echo 'https://stripev2-production-723a.up.railway.app' \
  | vercel env add API_URL preview

printf '%s' "$INTERNAL_API_TOKEN" | vercel env add INTERNAL_API_TOKEN production
printf '%s' "$INTERNAL_API_TOKEN" | vercel env add INTERNAL_API_TOKEN preview
```

Redeploy production:

```bash
vercel deploy --prod -y
```

Verify:

- https://stripev2-web-santhoshnarayans-projects.vercel.app/auth/sign-in → can sign in / sign up. This exercises the `/api/auth` proxy, which now forwards `x-internal-api-token`.
- Open any PR preview URL → same smoke test. This is the actual bug fix; previews should now reach the backend instead of hitting `ECONNREFUSED`.
- Backend is still in inert mode, so nothing has been gated yet. No risk to existing traffic.

---

## Step 3 — Turn on backend enforcement

```bash
railway variables set "INTERNAL_API_TOKEN=$INTERNAL_API_TOKEN"
```

(Or: Railway dashboard → StripeV2 project → server → Variables → Add.)

Railway restarts the service automatically. The gate is now live.

Verify immediately:

```bash
# Healthcheck still exempt
curl -sS https://stripev2-production-723a.up.railway.app/health
# → {"status":"ok"}

# Without a token — should now 401
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://stripev2-production-723a.up.railway.app/api/auth/session
# → 401

# With the token — should pass the gate
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "x-internal-api-token: $INTERNAL_API_TOKEN" \
  https://stripev2-production-723a.up.railway.app/api/auth/session
# → 200 (or whatever Better Auth returns)
```

Smoke-test prod in a browser: sign in, navigate, sign out. If anything 401s from the UI, the FE isn't sending the token — jump to rollback.

---

## Rollback (each step is independently reversible)

**Step 3 broke something** (prod showing 401s in the UI):

```bash
railway variables unset INTERNAL_API_TOKEN
```

The gate returns to inert mode within seconds of the service restart. No redeploy needed.

**Step 2 broke something** (new FE is buggy but backend is fine):

```bash
# Promote the previous production deployment
vercel ls --prod
vercel promote <previous-deployment-url>
```

The old FE was built with `NEXT_PUBLIC_API_URL` inlined into its bundle at build time, so it keeps working even after you've removed the Vercel env var. If you hadn't yet enabled step 3, there's no backend gating either, so rollback is clean.

**Step 1 broke something** (backend regression unrelated to gating):

```bash
gh pr revert 2
# Railway re-ships the pre-PR commit
```

---

## Post-deploy cleanup (after ~24h of healthy production)

- Delete `NEXT_PUBLIC_API_URL` from Vercel (Production + Preview + Development):
  ```bash
  vercel env rm NEXT_PUBLIC_API_URL production -y
  vercel env rm NEXT_PUBLIC_API_URL preview -y
  vercel env rm NEXT_PUBLIC_API_URL development -y
  ```
- If the token was transmitted over any channel you don't fully trust, rotate it:
  1. Generate a new one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  2. Set the new value on Vercel (Production + Preview) first
  3. Redeploy Vercel
  4. Then set the new value on Railway — during the few seconds between Vercel redeploy and Railway restart, old in-flight requests with the previous token will 401. Accept or do it during a quiet window.

## Local dev

Update your local `.env`:

```diff
- NEXT_PUBLIC_API_URL="http://localhost:4001"
+ API_URL="http://localhost:4001"
```

Do **not** set `INTERNAL_API_TOKEN` locally unless you also want to test the gate — the backend middleware is intentionally a no-op when the var is unset, so everything keeps working.
