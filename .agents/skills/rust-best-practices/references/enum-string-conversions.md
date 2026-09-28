# Enum String Conversions

## Contents

* [Choose by contract](#choose-the-conversion-by-contract)
* [Static English labels](#prefer-strum-for-static-english-labels)
* [Variant identity](#keep-strum-on-variant-identity)
* [Display, parsing, and enumeration](#separate-display-text-from-static-labels-and-i18n)
* [Partial conversions](#avoid-partial-generated-conversions)
* [Localization boundary](#keep-strum-english-only)
* [Testing](#test-the-mapping)

String conversion choices should reveal the contract: a static English variant
label, user-facing English display text, parse input, a label list, a round trip,
or localized text. Pick the smallest conversion surface that matches that
contract.

The dependency adoption boundary in `../SKILL.md` applies throughout this
chapter. Use the Strum house style when the repository already adopts it or the
user authorizes its introduction. Preserve existing manual mappings and pinned
versions otherwise; a small label change does not authorize adding or upgrading
a dependency, and a manual mapping alone is not a correctness finding.

Within the adopted Strum style, prefer Strum for static English variant labels,
even for small enums. Enum size alone is not a reason to introduce a second
mapping style. The maintainability win comes from keeping the variant and its
canonical label in one place, using the same convention everywhere, and making
the mapping available to both runtime and `const` callers.

When Strum is used for a static label and the adopted version supports it, derive
`IntoStaticStr` with `#[strum(const_into_str)]`. Expose a domain-specific wrapper
such as `label()`, `metric_label()`, or `wire_name()` when that reads better at
call sites, but route that wrapper through the generated `into_str()` method.

Strum-generated strings are for stable English labels, ASCII-ish protocol tokens,
metric labels, CLI values, schema terms, and other non-localized identifiers. Do
not use Strum as an i18n layer. If text may vary by locale, grammar, plural rules,
runtime language, translator-owned wording, or user preference, use a localization
layer such as `es-fluent`/Fluent or a project-specific i18n abstraction instead.

## Choose the Conversion by Contract

The library preferences below apply when adoption is established or authorized.

| Contract | Prefer |
| --- | --- |
| Fixed `&'static str` label for variant identity | `strum_macros::IntoStaticStr` with `#[strum(const_into_str)]`, regardless of enum size |
| Fixed label needed in a `const` context | The same `IntoStaticStr` + `#[strum(const_into_str)]` path |
| User-facing fixed English text for formatting | `Display`, usually manual when wording matters; test the visible wording |
| Localized or locale-ready user-facing text | A localization layer such as `es-fluent`/Fluent, not Strum attributes |
| Parsing external strings | `EnumString`, with explicit aliases and error tests; combine with `IntoStaticStr` + `const_into_str` when the enum also has one canonical static English output label |
| Enumerating all public names | `VariantNames` when the public name list is the contract |
| Enumerating all unit variants as values | `VariantArray` when every variant is unit-like |
| Payload-carrying enum where only variant identity matters | `EnumDiscriminants` to generate a fieldless kind enum, then `IntoStaticStr` + `const_into_str` on that generated discriminant enum |
| Labels depend on payload data, runtime state, localization, grammar, pluralization, or complex `cfg` rules | A manual method, `Display`, or an i18n/message type instead of a static Strum label |

Within the adopted Strum style, do not hand-write a static variant-label mapping
merely because an enum is small. The standard pattern is Strum plus
`const_into_str`. Manual matches remain appropriate for contracts Strum should
not model, unsupported versions, existing repository conventions, or boundaries
where a generated method would obscure behavior.

## Prefer Strum for Static English Labels

When an enum maps each variant to one fixed English label under the adopted
Strum style, derive `IntoStaticStr` and enable `const_into_str`. This keeps the
variant and string mapping in one place, removes repetitive `match` arms, and
gives both runtime and `const` callers a stable `into_str()` method.

```rust
use strum_macros::IntoStaticStr;

#[derive(Clone, Copy, Debug, Eq, PartialEq, IntoStaticStr)]
#[strum(const_into_str, serialize_all = "kebab-case")]
enum ArtifactKind {
    SourceMap,
    BuildLog,
    #[strum(to_string = "sbom")]
    SoftwareBillOfMaterials,
}

impl ArtifactKind {
    pub const fn label(self) -> &'static str {
        self.into_str()
    }
}

const BUILD_LOG_LABEL: &str = ArtifactKind::BuildLog.label();

assert_eq!(BUILD_LOG_LABEL, "build-log");
assert_eq!(ArtifactKind::SourceMap.label(), "source-map");
assert_eq!(ArtifactKind::SoftwareBillOfMaterials.label(), "sbom");
```

Use `to_string = "..."` for the single canonical output string. Use
`serialize = "..."` mainly for accepted input aliases when the enum also derives a
parsing trait. If every variant follows a regular casing convention, put
`#[strum(serialize_all = "...")]` on the enum and add per-variant `to_string`
overrides only for exceptions.

Avoid writing label methods as `self.into()` when `const_into_str` is available.
`Into`/`From` is still useful at runtime, but it is not the clearest house style
for labels that may be used from `const` contexts. Prefer routing domain-specific
methods through `self.into_str()` so the enum has one obvious canonical static
label path.

## Keep Strum on Variant Identity

`const_into_str` is best for variant identity: unit variants, C-like enums, and
fieldless kind/discriminant enums. Strum can derive static labels for
payload-bearing variants, but the generated label is still a label for the
variant, not for the payload value. If the string changes with payload data, do
not use `IntoStaticStr` for that string.

For payload-bearing enums, prefer Strum's `EnumDiscriminants` when the label
contract is about the variant kind. Derive the static label on the generated
fieldless discriminant enum and use its generated `From<&Event>` conversion
rather than duplicating the variant mapping in a manual match.

```rust
use strum_macros::{EnumDiscriminants, IntoStaticStr};

#[derive(Debug, EnumDiscriminants)]
#[strum_discriminants(name(EventKind))]
#[strum_discriminants(derive(IntoStaticStr))]
#[strum_discriminants(strum(const_into_str, serialize_all = "snake_case"))]
enum Event {
    Click { x: u16, y: u16 },
    KeyPress(char),
}

impl EventKind {
    pub const fn metric_label(self) -> &'static str {
        self.into_str()
    }
}

impl Event {
    fn kind(&self) -> EventKind {
        EventKind::from(self)
    }

    fn metric_label(&self) -> &'static str {
        self.kind().metric_label()
    }
}

assert_eq!(Event::Click { x: 10, y: 20 }.metric_label(), "click");
assert_eq!(Event::KeyPress('q').metric_label(), "key_press");
```

This separation prevents payload-bearing events, commands, diagnostics, or UI
messages from smuggling formatting or localization concerns into a static variant
label. Use Strum for the stable English kind; use `Display`, structured fields, or
i18n for the human text.

## Do Not Replace Static Labels with Manual Matches

Once Strum is adopted for static labels, do not replace that convention with a
manual `const fn` match merely because an enum is small. Even a two-variant enum
can use the standard Strum pattern. This is a consistency preference within an
adopted style, not authorization to migrate an existing repository.

Prefer this within the Strum style:

```rust
use strum_macros::IntoStaticStr;

#[derive(Clone, Copy, Debug, Eq, PartialEq, IntoStaticStr)]
#[strum(const_into_str, serialize_all = "snake_case")]
enum AddressLocalePool {
    CityPrefix,
    CitySuffix,
}

impl AddressLocalePool {
    pub const fn label(self) -> &'static str {
        self.into_str()
    }
}

const DEFAULT_POOL: &str = AddressLocalePool::CityPrefix.label();

assert_eq!(DEFAULT_POOL, "city_prefix");
```

The equivalent manual implementation is valid, but needlessly introduces a
second mapping style when the repository has standardized on Strum:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AddressLocalePool {
    CityPrefix,
    CitySuffix,
}

impl AddressLocalePool {
    pub const fn label(self) -> &'static str {
        match self {
            Self::CityPrefix => "city_prefix",
            Self::CitySuffix => "city_suffix",
        }
    }
}
```

Keep manual mappings when they are the established repository convention, when
Strum cannot represent the API safely, or when the adopted version does not
support `const_into_str`. Introduce or upgrade Strum only within authorized
dependency work after checking MSRV, target, feature, and API constraints.

## Separate Display Text from Static Labels and i18n

Do not use `Display::to_string()` when the caller needs `&'static str`; it
allocates a `String` and cannot be used in const contexts. Use the static label
method for identifiers, metrics, schema names, generated code, and internal
compatibility tokens.

Reserve `Display` for fixed English formatting and messages. Do not use Strum
`Display`, `EnumMessage`, `serialize`, or `to_string` attributes for translated
copy. If the text may be localized, route through a typed i18n message and a
runtime localization manager instead.

```rust
use std::fmt;
use strum_macros::IntoStaticStr;

#[derive(Clone, Copy, Debug, Eq, PartialEq, IntoStaticStr)]
#[strum(const_into_str, serialize_all = "snake_case")]
enum JobState {
    Queued,
    Running,
    Complete,
}

impl JobState {
    pub const fn metric_label(self) -> &'static str {
        self.into_str()
    }
}

impl fmt::Display for JobState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Queued => "queued for execution",
            Self::Running => "running",
            Self::Complete => "complete",
        };
        f.write_str(text)
    }
}

const QUEUED_METRIC_LABEL: &str = JobState::Queued.metric_label();

assert_eq!(QUEUED_METRIC_LABEL, "queued");
assert_eq!(JobState::Queued.to_string(), "queued for execution");
```

A static label is a compatibility contract. Display text is user-facing English
wording. Localized text is a translation contract. Keep those three contracts
separate.

## Use `EnumString` for External Input Contracts

Derive parsing only when strings enter from a public or external boundary: CLI
flags, config files, schemas, wire formats, environment variables, user input, or
persisted data. Keep aliases explicit and test the accepted spellings.

When the enum also needs a canonical static output label, combine `EnumString`
with `IntoStaticStr` and `const_into_str`.

```rust
use strum_macros::{EnumString, IntoStaticStr};

#[derive(Clone, Copy, Debug, Eq, PartialEq, EnumString, IntoStaticStr)]
#[strum(const_into_str, serialize_all = "kebab-case")]
enum OutputFormat {
    Json,
    #[strum(to_string = "ndjson", serialize = "jsonl")]
    NewlineDelimitedJson,
}

impl OutputFormat {
    pub const fn label(self) -> &'static str {
        self.into_str()
    }
}

assert_eq!("json".parse::<OutputFormat>().unwrap(), OutputFormat::Json);
assert_eq!(
    "jsonl".parse::<OutputFormat>().unwrap(),
    OutputFormat::NewlineDelimitedJson
);
assert_eq!(OutputFormat::NewlineDelimitedJson.label(), "ndjson");
for format in [OutputFormat::Json, OutputFormat::NewlineDelimitedJson] {
    assert_eq!(format.label().parse::<OutputFormat>().unwrap(), format);
}
assert!("xml".parse::<OutputFormat>().is_err());
```

Use `ascii_case_insensitive` only when ASCII case folding is the intended input
contract. Do not treat it as Unicode normalization or localization.

For very large parse enums, Strum can generate a PHF-backed lookup. Treat that as
a measured optimization, not a default; test it against the repository's real enum
size and input distribution before standardizing it.

## Enumerate Names Deliberately

Use `VariantNames` when the list of public names is itself part of the contract.
Use `VariantArray` when the code needs a static list of the unit variants as
values. Keep the name list and the canonical `into_str()` label mapping aligned
with tests, especially when using `to_string` overrides or parse aliases.

```rust
use strum::VariantNames as _;
use strum_macros::{IntoStaticStr, VariantNames};

#[derive(Clone, Copy, Debug, Eq, PartialEq, IntoStaticStr, VariantNames)]
#[strum(const_into_str, serialize_all = "kebab-case")]
enum CachePolicy {
    NoStore,
    Revalidate,
    #[strum(to_string = "stale-while-revalidate")]
    StaleWhileRevalidate,
}

impl CachePolicy {
    pub const fn label(self) -> &'static str {
        self.into_str()
    }
}

assert_eq!(CachePolicy::NoStore.label(), "no-store");
assert!(CachePolicy::VARIANTS.contains(&"no-store"));
```

If the public list has special ordering, filtering, feature-gated entries, or
non-Strum naming rules, use a hand-maintained slice and test it directly. Do not
replace `IntoStaticStr` with a manual slice lookup merely because the enum is
small.

## Avoid Partial Generated Conversions

Static label conversion should usually be total. Avoid `#[strum(disabled)]` on an
enum whose output conversion must handle every variant; disabled variants are
removed from generated code and can turn a simple label contract into a partial or
panic-prone conversion.

Do not combine `#[strum(const_into_str)]` with `#[strum(transparent)]`;
transparent delegation relies on `From::from(variant)`, while `const_into_str`
needs a direct const mapping.

Keep manual code when variants are gated by complex `cfg` rules, when only some
variants should parse, when generated match behavior would obscure a public
compatibility boundary, or when a public enum must not expose Strum's generated
`into_str()` method.

## Keep Strum English-Only

Use Strum labels for stable English tokens and identifiers:

* metric labels
* log categories
* schema names
* CLI/config values
* protocol labels
* generated-code labels
* English-only compatibility strings

Do not use Strum labels for translated UI copy, locale names, pluralized text,
gendered text, runtime language selection, or translator-owned wording. For those
contracts, model a typed message and localize it through the repository's i18n
stack, such as `es-fluent`/Fluent.

A Strum label may be a message key, but it should not be the localized message.

## Test the Mapping

Test string conversions when labels are public, serialized, parsed, documented, or
used by generated code.

* Assert the canonical `into_str()` output for every variant.
* Prefer at least one `const` assertion or `const` binding for each enum that uses
  `const_into_str`, so the generated const path is exercised.
* Assert accepted parse aliases and rejected inputs for public parsers.
* Assert case-insensitive behavior only when it is part of the contract.
* Add feature- or target-specific tests when variants or labels are behind `cfg` or
  feature gates.
* Keep README, CLI help, schema examples, fixtures, snapshots, and generated
  output aligned when a public label changes.
* Keep Strum label tests separate from localization tests; translated wording
  belongs in i18n resource tests or snapshots.

Prefer structural assertions over formatting through `Display` when the contract
is a static label. Assert exact text only when wording itself is user-facing API.
