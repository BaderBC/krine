# Product vision

## Thesis

Krine is an open-source, self-hosted platform that continuously accumulates trust context and lets an application ask whether a subject may perform an arbitrary action.

The product should feel conceptually like:

```text
observe over time
      ↓
derive useful trust context
      ↓
check("can_do_x")
      ↓
allow / deny / require additional proof
```

The check name is application-defined. Krine does not need built-in semantic knowledge of concepts such as "registration", "trial" or "withdrawal".

Examples:

- `can_register`
- `can_login`
- `can_claim_trial`
- `can_create_api_key`
- `can_send_email`
- `can_publish_listing`

## What makes Krine useful

The value is not a list of isolated security features.

Fingerprinting, IP reputation, bot detection, behavioral history, relationships, challenge providers and application events are useful because together they make a check more informed.

The platform should centralize:

- historical trust context;
- reusable metrics;
- application-specific policies;
- step-up verification;
- explainable decisions.

The backend should not need to manually combine a dozen fraud/security tools for every protected action.

## Self-hosting

Self-hosting is a core product property, not a deployment afterthought.

The complete core product must be able to run without dependence on Krine-hosted infrastructure.

A future hosted Krine offering may run the same product for customers who prefer managed operations.

A future cross-customer intelligence network may improve local decisions, but Krine must remain useful without it.

## Product shape

The long-term product may support bot protection, abuse prevention and fraud use cases, but the user-facing abstraction should remain generic:

> Should this subject be trusted to perform this action now?

## What Krine is not

Krine is not primarily:

- an authentication provider;
- an IAM system;
- a KYC platform;
- a CAPTCHA vendor;
- a WAF;
- a SIEM;
- a generic workflow automation tool;
- a generic product analytics platform.

Krine may integrate with several of these.

## Quality philosophy

Feature count is secondary.

A smaller feature that behaves predictably during retries, failures, missing data, concurrent requests and investigation is more valuable than a broad but shallow surface.

Every important Krine feature should feel production-ready, explainable and intentional.
