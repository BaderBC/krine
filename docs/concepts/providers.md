# Providers

Krine should be modular around replaceable external capabilities.

## Principle

Policies and metrics should depend on normalized Krine concepts, not provider-specific JSON.

Prefer:

```text
ip.risk
```

over:

```text
vendor_x.risk_score
```

This lets a customer replace providers without rewriting their policy model.

## Expected provider categories

The MVP starts with:

- IP intelligence;
- challenge / CAPTCHA-like verification.

Engineering selects one default challenge provider and one IP intelligence provider behind generic capability contracts. Add custom HTTP-provider support only if it is inexpensive to implement; otherwise defer it. See [MVP contract defaults](../decisions/0007-mvp-contract-defaults.md).

Later categories may include:

- email/domain intelligence;
- phone intelligence;
- device intelligence;
- custom external signals.

## Examples

An IP intelligence slot might be implemented by:

- a local database;
- MaxMind;
- IPinfo;
- another service;
- a custom HTTP adapter.

A challenge slot might be implemented by:

- a self-hosted proof/challenge implementation;
- Turnstile;
- hCaptcha;
- another provider;
- a custom integration.

The vendor choices remain delegated to engineering; these examples do not commit the MVP to particular integrations.

## Provider behavior

Shipped providers must make explicit:

- timeout behavior;
- caching;
- freshness;
- unavailable/error state;
- normalized output;
- provenance.

Provider failure must not silently convert into a "safe" result.

Engineering chooses normalized schemas and sensible cache, freshness and timeout defaults, with configuration where useful. These choices must preserve visible missing-data and failure semantics without coupling business policies to a vendor.

## Product boundary

Provider-specific configuration belongs in provider setup.

Business policies should remain portable across provider changes wherever semantics allow it.
