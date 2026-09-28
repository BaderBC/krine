# Krine

**Krine (`krine.dev`) is an open-source, self-hosted trust decision engine.**

It helps an application answer questions such as:

- can this visitor register?
- can this account claim another trial?
- can this user create an API key?
- can this session perform a sensitive action?

The application sends Krine events and client-side trust signals over time. Krine turns them into reusable metrics, evaluates no-code policies, and returns an explainable decision when the backend performs a check.

The mental model is intentionally small:

**Events → Entities → Metrics → Checks → Decisions**

Krine is not an auth provider, CAPTCHA product, WAF or generic analytics platform. Those can be inputs or integrations. Krine's job is to decide whether a subject should be trusted to perform a specific application action now.

## Repository context

Start with:

- `docs/product/vision.md`
- `docs/product/mvp.md`
- `ARCHITECTURE.md`
- `docs/open-questions.md`

For coding agents, see `AGENTS.md`.
