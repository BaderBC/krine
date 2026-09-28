# UX principles

Krine should feel closer to a focused Apple utility than a typical enterprise security dashboard.

## Primary goal

Make complex trust infrastructure feel simple without hiding important security meaning.

The [information architecture](information-architecture.md) and [core user flows](core-flows.md) apply these principles to the MVP. This document remains the higher-level product taste.

## Principles

### Minimal surfaces

Prefer fewer screens, fewer buttons and shallower navigation.

Do not expose every backend capability as a separate navigation item.

### Checks are central

A developer thinks in terms of:

- `can_register`
- `can_claim_trial`
- `can_send_email`

The UI should make checks a primary product surface rather than organizing everything around vendor jargon such as "fraud", "bot management", "risk modules" or provider names.

### Progressive disclosure

Show the smallest amount of information required for the current task.

Allow a user to drill into metric internals, evidence or identity relationships only when needed.

### Quiet visual design

Prefer:

- whitespace;
- restrained typography;
- compact information density;
- familiar controls;
- clear hierarchy;
- simple diagrams only when they genuinely explain something.

Avoid:

- giant marketing-style cards;
- decorative gradients;
- excessive rounded containers;
- unnecessary illustrations;
- dashboard widgets added only to make a page look "full";
- complex navigation trees;
- visually noisy "AI-generated SaaS" patterns.

### Explainability without clutter

A decision explanation should read like a short reasoning trace:

```text
can_claim_trial → DENY

client.user_count_30d = 7
policy requires <= 3
```

A user can then inspect the metric or policy in more depth.

### Metrics should teach

Every metric gets a readable page explaining:

- what it means;
- whether it is primitive or derived;
- its type/range;
- its dependencies;
- its missing-data behavior;
- its version.

No unexplained magic scores.

### Advanced configuration should not dominate

Provider settings, diagnostics and internals exist, but should not make the normal path feel like infrastructure administration.

## Design test

When adding a UI element, ask:

1. What user decision does this help make?
2. Can the same task remain obvious with less UI?
3. Is this explaining complexity, or merely exposing it?
