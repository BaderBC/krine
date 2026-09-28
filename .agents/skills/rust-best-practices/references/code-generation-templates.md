# Code Generation Templates

## Contents

* [Choose the renderer](#choose-the-smallest-renderer)
* [Build typed models](#build-a-typed-view-model-or-semantic-model)
* [Prepare Rust fragments](#prepare-rust-fragments-before-rendering)
* [Keep file templates structural](#make-templates-own-layout-only)
* [Keep macro emitters syntactic](#make-macro-emitters-own-syntax-only)
* [Test generator contracts](#test-the-generator-contract)
* [Synchronize generated output](#keep-generated-output-and-sources-in-sync)
* [Adopt templates selectively](#use-templates-when-they-improve-maintenance)

Use a template engine for generated Rust files when correctness and reviewability
depend on seeing the emitted file shape clearly. Templates are most useful for
checked-in or human-reviewed `.rs` files with nested modules, repeated item
groups, exact indentation, generated documentation, or several generated files
with shared structure.

Do **not** use text templates for procedural macros. Derive macros, attribute
macros, function-like macros, and other token-stream-oriented Rust generation
should be implemented with `syn`, `quote`, and `proc_macro2`. Askama, Jinja,
Handlebars, and similar text-template engines must never be considered for macro
expansion code. A macro emitter should be Rust code that parses Rust syntax,
builds a typed semantic model, and emits tokens.

Keep the generator pipeline explicit.

For generated files:

1. Load and validate source data.
2. Build deterministic Rust view models.
3. Render prepared values into templates or file-oriented token streams.
4. Compare, format, compile, or snapshot the generated output with the repository's
   normal codegen workflow.
5. When generation is run from `build.rs`, write intermediate build outputs only
   under `OUT_DIR`, declare precise `cargo::rerun-if-changed` or
   `cargo::rerun-if-env-changed` inputs, and keep checked-in generated sources
   updated by an explicit repository command instead of hidden build-script side
   effects.

For procedural macros:

1. Parse the input `TokenStream` into `syn` syntax.
2. Validate attributes and input shape into a typed semantic model.
3. Emit `proc_macro2::TokenStream` values with `quote!`, `quote_spanned!`, and
   small token-emission helpers.
4. Test expansion output with parse checks, snapshots, `trybuild`, compile-fail
   tests, or the repository's existing macro test workflow.

Keep domain logic in Rust and presentation in the renderer. Sorting, grouping,
feature selection, identifier validation, doc/comment wrapping, Rust string or
token escaping, span selection, facade-crate path selection, and diagnostics
should happen before rendering. For file templates, a good template mostly loops
over a typed view model and places already-prepared fields into the output. For
macros, a good emitter mostly combines typed model fields into `quote!` blocks.

## Choose the Smallest Renderer

Prefer the renderer that matches the generated surface:

| Generated surface | Prefer |
| --- | --- |
| Human-reviewed checked-in `.rs` files with repeated structure | Askama or the repository's existing text-template engine |
| Rust files where quoting, imports, and indentation need Rust-aware support | `genco`, when already used or justified by reviewability |
| File-oriented token generation from a `build.rs`, `xtask`, or generator binary | `quote` plus `syn` parsing and `prettyplease` formatting when that is simpler than a text template |
| Procedural macros, derives, attribute macros, function-like macros, and token-stream-oriented output | `syn`, `quote`, and `proc_macro2` |
| Macro attribute parsing, when the repository already uses it or the input shape warrants it | `darling` or focused `syn` parsing helpers |
| A few simple generated file lines | `writeln!`, `fmt::Write`, or the repository's existing direct renderer |

Do not introduce a template engine only to replace a short direct renderer. Do
not introduce a second code-generation style into a repository that already has a
clear renderer unless the generated output has become hard to audit or maintain.

Never introduce Askama, Jinja, Handlebars, or another text-template engine into a
proc-macro expansion path. A macro that is becoming too large should be split into
semantic models and token-emission helper functions, not moved into a text
template.

## Build a Typed View Model or Semantic Model

For file generation, create small render-only structs that expose the exact fields
the template needs. This keeps template failures obvious and keeps generation
decisions testable in Rust.

```rust
use askama::Template;

#[derive(Template)]
#[template(source = "{{ source_ref }}", ext = "rs", escape = "none")]
struct ErrorCodesTemplate<'a> {
    source_ref: &'a str,
    areas: &'a [AreaView],
}

struct AreaView {
    module_ident: String,
    codes: Vec<ErrorCodeView>,
}

struct ErrorCodeView {
    doc_attrs: Vec<String>,
    const_ident: String,
    code_literal: String,
    status: u16,
    retriable_literal: &'static str,
}
```

Render after building the view model, while borrowed source data is still alive
and before any generated output is written to disk:

```rust
# struct ErrorSpec { valid: bool }
# type RenderError = Box<dyn std::error::Error + Send + Sync>;
# const ERROR_SPEC_REF: &str = "errors.toml";
# fn build_error_code_views(spec: &ErrorSpec) -> Result<Vec<AreaView>, RenderError> {
#     if spec.valid {
#         Ok(Vec::new())
#     } else {
#         Err(std::io::Error::other("invalid error specification").into())
#     }
# }
# fn sample_error_spec() -> ErrorSpec { ErrorSpec { valid: true } }
fn render_error_codes(spec: &ErrorSpec) -> Result<String, RenderError> {
    let areas = build_error_code_views(spec)?;

    Ok(ErrorCodesTemplate {
        source_ref: ERROR_SPEC_REF,
        areas: &areas,
    }
    .render()?)
}
```

For macros, build a typed semantic model instead of a text-template view model.
The model should contain parsed and validated Rust syntax, semantic decisions,
spans for diagnostics, facade paths, and values that can be converted to tokens
without string assembly.

```rust
use proc_macro2::TokenStream;
use quote::quote;
use syn::{DeriveInput, LitStr};

struct CommandSpecModel<'a> {
    ident: &'a syn::Ident,
    generics: &'a syn::Generics,
    command_trait: syn::Path,
    name: LitStr,
    about: LitStr,
}

# impl<'a> CommandSpecModel<'a> {
#     fn from_input(input: &'a DeriveInput) -> syn::Result<Self> {
#         let span = input.ident.span();
#         let command_trait = syn::parse_str("CommandSpec")?;
#         Ok(Self {
#             ident: &input.ident,
#             generics: &input.generics,
#             command_trait,
#             name: LitStr::new(&input.ident.to_string().to_ascii_lowercase(), span),
#             about: LitStr::new("Generated command", span),
#         })
#     }
# }
fn expand_command_spec(input: &DeriveInput) -> syn::Result<TokenStream> {
    let model = CommandSpecModel::from_input(input)?;
    Ok(emit_command_spec(&model))
}

fn emit_command_spec(model: &CommandSpecModel<'_>) -> TokenStream {
    let ident = model.ident;
    let command_trait = &model.command_trait;
    let name = &model.name;
    let about = &model.about;
    let (impl_generics, ty_generics, where_clause) = model.generics.split_for_impl();

    quote! {
        impl #impl_generics #command_trait for #ident #ty_generics #where_clause {
            const NAME: &'static str = #name;
            const ABOUT: &'static str = #about;
        }
    }
}
```

A view model or semantic model should be deterministic. Sort maps and inventories
when order is not part of the input contract; preserve meaningful source order.
Deduplicate equivalent rows only when the contract allows it, and reject
conflicting rows before rendering. Resolve feature flags, `cfg` choices,
namespace choices, facade-crate paths, and generated identifiers before emission.

## Prepare Rust Fragments Before Rendering

For generated Rust files, a text template should usually run with source-code
escaping disabled and receive Rust-ready fragments. Do not rely on HTML escaping
defaults for Rust source code, and do not place raw external names or raw strings
directly into identifiers, literals, paths, attributes, or doc comments. Treat
`escape = "none"` as a renderer-level choice that is safe only because the Rust
view model has already escaped and validated every generated fragment.

Prepare these fields in Rust:

* `module_ident`, `const_ident`, `type_ident`, and other identifier fragments;
* string literals, byte string literals, char literals, and doc strings;
* `#[cfg(...)]`, feature, visibility, and attribute fragments;
* sorted item lists and grouped modules;
* comments that require wrapping or escaping;
* source references and generated-file preambles.

Use a single helper for each kind of generated fragment so escaping rules stay
consistent across templates.

```rust
use genco::prelude::{quote, quoted, rust};

fn rust_string_literal(value: &str) -> String {
    let tokens: rust::Tokens = quote!($(quoted(value)));
    tokens
        .to_string()
        .expect("genco renders a Rust string literal")
}

fn rust_doc_attr(line: &str) -> String {
    let literal = rust_string_literal(line);
    format!("#[doc = {literal}]")
}
```

`genco::prelude::quoted` keeps ordinary Unicode readable while escaping Rust
syntax and control characters. That makes it a good fit for generated diagnostic,
protocol, or fixture data where reviewability matters. When rendering a full file
through Genco, use the file-rendering path so imports and file-level formatting
are emitted; use fragment rendering only for fragments intentionally embedded into
another renderer.

For macros, do not prepare Rust syntax as strings. Prepare typed syntax and token
values:

* use `syn::Ident`, `syn::Path`, `syn::Type`, `syn::Expr`, `syn::Generics`, and
  `syn::WhereClause` for Rust syntax;
* use `syn::LitStr`, `syn::LitByteStr`, `syn::LitChar`, or `proc_macro2::Literal`
  when literal spans or literal kinds matter;
* use `quote!` interpolation for already-validated values;
* use `quote_spanned!` when generated errors, hidden assertions, or trait bounds
  should point back to user-written syntax;
* use `format_ident!` only after validating or normalizing source-derived names;
* use `syn::Error::new`, `syn::Error::new_spanned`, `darling` errors, or the
  repository's existing macro-error helper to return `compile_error!` tokens.

```rust
use proc_macro2::TokenStream;
use quote::{format_ident, quote};

fn emit_registration_module(
    type_ident: &syn::Ident,
    command_name: &syn::LitStr,
) -> TokenStream {
    let module_ident = format_ident!("__command_spec_for_{}", type_ident);

    quote! {
        #[doc(hidden)]
        mod #module_ident {
            const COMMAND_NAME: &str = #command_name;
        }
    }
}
```

For a field-dependent bound, clone the input generics, append a predicate for the
field type, and call `split_for_impl` on that augmented copy. Preserve existing
type, lifetime, and const parameters and `where` predicates. Keep the bound on
the field type itself, including an associated type such as `T::Item`, so only
the operations used by the generated implementation constrain callers.

The following emitter uses these dependencies, subject to the adoption boundary
in `../SKILL.md`:

```toml
[dependencies]
proc-macro2 = "1"
quote = "1"
syn = { version = "2", features = ["full"] }
```

```rust
use proc_macro2::TokenStream;
use quote::quote;
use syn::spanned::Spanned as _;

fn emit_field_parser(input: &syn::DeriveInput, field: &syn::Field) -> TokenStream {
    let ident = &input.ident;
    let ty = &field.ty;
    let mut generics = input.generics.clone();
    generics.make_where_clause().predicates.push(syn::parse_quote_spanned! {
        ty.span()=> #ty: ::core::str::FromStr
    });
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();

    quote! {
        impl #impl_generics #ident #ty_generics #where_clause {
            fn parse_field(input: &str) -> ::core::result::Result<
                #ty,
                <#ty as ::core::str::FromStr>::Err,
            > {
                <#ty as ::core::str::FromStr>::from_str(input)
            }
        }
    }
}
```

This emits a parsing method on the input type for the selected field. Test the
emitted implementation with generic and concrete field types, preserved bounds,
and a caller whose field type fails the required bound.

Use `proc_macro2::Literal` or `syn::Lit*` when the generated surface is
token-stream-oriented or the repository already uses `proc_macro2` for that
renderer.

```rust
fn token_string_literal(value: &str) -> proc_macro2::Literal {
    proc_macro2::Literal::string(value)
}
```

Avoid `proc_macro2::Literal` for large human-reviewed string tables when its
escaping style would make checked-in diffs noisy. Avoid `quote::format_ident!` or
`proc_macro2::Ident::new` on unchecked source data; invalid identifiers panic at
the construction boundary. Validate or normalize identifiers before constructing
those values, and make raw-identifier handling explicit when keywords are allowed.

## Make Templates Own Layout Only

Keep template files short and structural. The template should communicate the
emitted Rust file shape, not hide generator policy in conditionals and filters.

```jinja
// Source: {{ source_ref }}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ErrorCode {
    pub code: &'static str,
    pub http_status: u16,
    pub retriable: bool,
}

{% for area in areas %}pub(crate) mod {{ area.module_ident }} {
    use super::ErrorCode;
{% for code in area.codes %}{% for attr in code.doc_attrs %}    {{ attr }}
{% endfor %}    pub(crate) const {{ code.const_ident }}: ErrorCode = ErrorCode {
        code: {{ code.code_literal }},
        http_status: {{ code.status }},
        retriable: {{ code.retriable_literal }},
    };
{% endfor %}}
{% endfor -%}
```

When whitespace matters, prefer exact-output tests over eyeballing trim markers.
Inline control tags with emitted lines when that makes indentation deterministic.
Use `#[rustfmt::skip]` only when preserving generated layout is intentional; when
normal Rust formatting is desired, format generated files through the repository's
normal codegen or formatting command. For token-generated files outside a
proc-macro expansion path, consider parsing the tokens as `syn::File` and running
`prettyplease::unparse` when the repository does not want to shell out to
`rustfmt` from the generator.

## Make Macro Emitters Own Syntax Only

Macro expansion code should make Rust syntax visible through `quote!` blocks and
helper functions. It should not hide generated Rust in template files or large
string literals.

Keep macro entrypoints thin:

```text
use syn::{parse_macro_input, DeriveInput};

#[proc_macro_derive(CommandSpec, attributes(command))]
pub fn derive_command_spec(input: proc_macro::TokenStream) -> proc_macro::TokenStream {
    let input = parse_macro_input!(input as DeriveInput);

    match expand_command_spec(&input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}
```

Prefer this structure:

* an entrypoint that parses `proc_macro::TokenStream`;
* an `expand_*` function that returns `syn::Result<proc_macro2::TokenStream>` or
  the repository's existing macro result type;
* semantic model builders for attribute parsing, shape validation, naming,
  hygiene, facade paths, and feature decisions;
* focused `emit_*` helpers for trait impls, modules, match arms, constants, and
  registration blocks;
* tests that call `expand_*` directly with `syn::parse_quote!`.

Do not build macro output with `format!`, `writeln!`, raw strings, or Jinja-style
templates. String construction is acceptable for semantic values such as command
names, doc text, or generated names before they are converted into validated
literals or identifiers. It is not acceptable as the primary way to assemble Rust
syntax in a macro.

Procedural macro output is unhygienic from the caller's point of view. Resolve
paths before emission, prefer absolute paths for library items, avoid common
helper names, and keep generated private names intentionally obscure enough to
avoid collisions. When the macro needs to refer to a facade crate, parse or
resolve that path into the semantic model rather than sprinkling stringly paths
through emitters.

## Test the Generator Contract

Generated source is a contract. Test the Rust decisions and the emitted shape.

For generated files:

* Unit-test view-model construction: sorting, grouping, deduplication, feature
  selection, identifier validation, empty groups, and conflict handling.
* Unit-test literal and identifier helpers with quotes, backslashes, newlines,
  control characters, Unicode, keywords, and invalid input.
* Use byte-for-byte assertions or small fixtures for representative renderer
  output.
* For large generated files, pair focused renderer tests with the repository's
  codegen check command and review the generated diff.
* When generated Rust is checked in or published, compile the owning crate or run
  the focused test that exercises the generated API.

```rust
#[test]
fn renders_error_code_bindings_from_template() {
    let output = render_error_codes(&sample_error_spec()).expect("error-code template renders");

#     #[cfg(not(test))]
    assert_eq!(output, include_str!("fixtures/error_codes.rs"));
#     #[cfg(test)]
#     assert_eq!(output, ERROR_SPEC_REF);
}
```

For macros:

* Unit-test semantic model construction from `syn::DeriveInput`, `syn::Item`, or
  the relevant parsed input type.
* Unit-test attribute parsing, invalid combinations, naming, namespace or feature
  resolution, generics handling, raw identifiers, facade paths, hygiene-sensitive
  names, and span-sensitive diagnostics.
* Use `quote!(...)`, `syn::parse_quote!`, and `syn::parse2` in tests instead of
  hand-written output strings where possible.
* Pretty-print expansion snapshots with the repository's existing snapshot helper
  or `prettyplease` when that is already part of the test stack.
* Use `trybuild` or equivalent compile-pass and compile-fail tests for public
  proc-macro behavior.
* Assert that invalid user input expands to clear `compile_error!` output and
  points at the right syntax when spans matter.

```rust
#[test]
fn derive_command_spec_emits_trait_impl() {
    let input: syn::DeriveInput = syn::parse_quote! {
        #[command(name = "serve", about = "Run the HTTP server")]
        struct Serve<'a> {
            config_path: &'a std::path::Path,
        }
    };

    let tokens = expand_command_spec(&input).expect("macro expands");
    let file: syn::File = syn::parse2(tokens).expect("expanded tokens parse as Rust");

    assert!(file.items.iter().any(|item| matches!(item, syn::Item::Impl(_))));
}
```

For user-facing diagnostics, add compile-pass and compile-fail fixtures when the
macro is public or when spans are part of the contract:

```rust,no_run
#[test]
fn ui() {
    let t = trybuild::TestCases::new();
    t.pass("tests/ui/command_spec_ok.rs");
    t.compile_fail("tests/ui/command_spec_missing_name.rs");
    t.compile_fail("tests/ui/command_spec_unknown_attribute.rs");
}
```

Adapt this outline into the consuming crate's integration tests and provide its
proc-macro implementation, UI fixtures, and reviewed `.stderr` expectations.
The aggregate snippet check typechecks this outline without running absent
fixtures; runnable bundled examples execute their contained `#[test]` functions.

Keep the complete reviewed file output in a fixture such as
`fixtures/error_codes.rs` when layout is part of the contract; substring checks
alone can miss missing, duplicated, or malformed items. Pair text comparisons
with parsing or compilation where Rust validity matters.

Use snapshots when the adopted workflow makes a larger output easier to review;
propose a new snapshot dependency explicitly under the dependency boundary.
Normalize only incidental nondeterminism outside the tested contract. Preserve
meaningful ordering, values, and diagnostics rather than masking regressions.

## Keep Generated Output and Sources in Sync

When a generated Rust surface changes, update the source data, generator code,
template or token emitter, generated output, tests, fixtures, snapshots, and
public docs that name the generated API in the same change. Do not hand-edit
checked-in generated Rust unless the repository explicitly treats that file as
the source of truth.

Use the repository's existing generation command, such as an `xtask`, `just`,
`make`, or package-specific codegen recipe. If no command is evidenced, state
that the change was reviewed only and avoid inventing a validation workflow.

For build-script-generated files included with `include!(concat!(env!("OUT_DIR"),
"/..."))`, keep the checked-in source spec, generator logic, and `rerun-if-*`
inputs aligned. Do not write checked-in files from a normal Cargo build.

For proc macros, validate through the repository's macro test workflow. Prefer
focused expansion tests plus compile-pass or compile-fail tests over manually
inspecting token strings. When macro output is part of a public API, compile at
least one representative downstream use or fixture crate.

## Use Templates When They Improve Maintenance

Prefer a template when it reduces dense `writeln!` blocks, makes checked-in
generated file structure easier to review, or lets compile-time checks catch
missing fields. Keep direct rendering when the output is only a few lines, the
output is naturally a token stream, or adding a template engine would create a
second pattern in a codebase with a settled renderer style.

Do not use templates for procedural macros. When the task is a derive macro,
attribute macro, function-like macro, or any other macro-generated Rust surface,
use `syn` to parse, a typed semantic model to validate, and `quote` /
`proc_macro2` to emit tokens.
