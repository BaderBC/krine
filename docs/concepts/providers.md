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

Initial categories likely include:

- IP intelligence;
- challenge / CAPTCHA-like verification;
- email/domain intelligence.

Later categories may include:

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

No default provider choice is locked by this document.

## Provider behavior

Providers should eventually make explicit:

- timeout behavior;
- caching;
- freshness;
- unavailable/error state;
- normalized output;
- provenance.

Provider failure must not silently convert into a "safe" result.

## Product boundary

Provider-specific configuration belongs in provider setup.

Business policies should remain portable across provider changes wherever semantics allow it.
