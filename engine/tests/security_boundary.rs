//! Verifies, at the source level, that the Hyperliquid private key can
//! never reach the context-building code path that talks to Jev, never
//! reaches a logging call, and never reaches any struct returned across
//! the engine<->Express boundary — the acceptance criteria for #14
//! ("private key never appears in the state/context payload built for
//! Jev") that unit tests on individual functions can't prove by
//! themselves, since a unit test only checks the inputs it was given,
//! not that some *other* code path couldn't have wired the key in.
//!
//! These checks read the crate's own source files. They fail loudly
//! (rather than silently passing) if a file is renamed or moved,
//! forcing this test to be updated deliberately alongside any such
//! move — which is the point: this is meant to be a tripwire.

use std::fs;
use std::path::Path;

const SRC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src");

/// Files allowed to know the private key exists at all: where it's
/// parsed/held (`hyperliquid_signing.rs`), where it signs orders and
/// exposes only the derived public address (`live_execution.rs`), and
/// where it's read from the environment at startup (`main.rs`).
const ALLOWED_KEY_AWARE_FILES: &[&str] = &[
    "decision/hyperliquid_signing.rs",
    "decision/live_execution.rs",
    // Only re-exports the `PrivateKey` type name; holds no key material.
    "decision/mod.rs",
    // Builds a `PrivateKey` from each live wallet's decrypted key when
    // refreshing the wallet registry; holds no HYPERLIQUID_PRIVATE_KEY
    // reference of its own (wallets are keyed by `WALLET_ENCRYPTION_KEY`
    // instead).
    "wallets.rs",
];

fn all_source_files() -> Vec<(String, String)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                let contents = fs::read_to_string(&path).unwrap();
                out.push((relative, contents));
            }
        }
    }

    let mut out = Vec::new();
    walk(Path::new(SRC_DIR), Path::new(SRC_DIR), &mut out);
    out
}

#[test]
fn the_private_key_env_var_is_only_read_in_allowed_files() {
    for (relative_path, contents) in all_source_files() {
        if contents.contains("HYPERLIQUID_PRIVATE_KEY") {
            assert!(
                ALLOWED_KEY_AWARE_FILES.contains(&relative_path.as_str()),
                "HYPERLIQUID_PRIVATE_KEY referenced outside its allowed module boundary in {relative_path}",
            );
        }
    }
}

#[test]
fn the_private_key_type_is_only_used_in_allowed_files() {
    for (relative_path, contents) in all_source_files() {
        // The type's own definition file always "uses" it; only flag
        // *other* files referencing it outside the allowed boundary.
        if relative_path == "decision/hyperliquid_signing.rs" {
            continue;
        }
        if contents.contains("PrivateKey") {
            assert!(
                ALLOWED_KEY_AWARE_FILES.contains(&relative_path.as_str()),
                "PrivateKey type referenced outside its allowed module boundary in {relative_path}",
            );
        }
    }
}

#[test]
fn the_jev_context_building_module_never_mentions_the_key_or_hyperliquid_credentials() {
    let contents = fs::read_to_string(Path::new(SRC_DIR).join("decision/history.rs")).unwrap();
    assert!(
        !contents.contains("PrivateKey")
            && !contents.contains("HYPERLIQUID_PRIVATE_KEY")
            && !contents.contains("hyperliquid_signing"),
        "decision/history.rs (which builds the state/context string sent to Jev) must never reference private-key material",
    );
}

#[test]
fn the_jev_decision_source_module_never_mentions_the_key_or_hyperliquid_credentials() {
    for relative_path in [
        "decision/typesafe_jev_decision_maker.rs",
        "decision/openrouter_jev_decision_maker.rs",
    ] {
        let contents = fs::read_to_string(Path::new(SRC_DIR).join(relative_path)).unwrap();
        assert!(
            !contents.contains("PrivateKey")
                && !contents.contains("HYPERLIQUID_PRIVATE_KEY")
                && !contents.contains("hyperliquid_signing"),
            "{relative_path} (which sends the context to Jev) must never reference private-key material",
        );
    }
}

#[test]
fn no_tracing_call_anywhere_references_the_key() {
    for (relative_path, contents) in all_source_files() {
        for line in contents.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("tracing::") {
                assert!(
                    !trimmed.contains("key") && !trimmed.contains("private_key"),
                    "a tracing:: call in {relative_path} appears to reference key material: {trimmed}",
                );
            }
        }
    }
}

#[test]
fn private_key_does_not_derive_a_formatting_or_serialization_trait_that_would_leak_it() {
    let contents =
        fs::read_to_string(Path::new(SRC_DIR).join("decision/hyperliquid_signing.rs")).unwrap();
    let lines: Vec<&str> = contents.lines().collect();
    let struct_line = lines
        .iter()
        .position(|line| line.contains("pub struct PrivateKey(SigningKey);"))
        .expect("PrivateKey's definition changed shape; re-verify it still can't derive Debug/Serialize");

    // The line(s) immediately preceding the struct must not be a
    // #[derive(...)] attribute — PrivateKey has a hand-written,
    // redacting Debug impl instead (checked below), and no Serialize
    // impl at all, so it can never be JSON-encoded into an Express
    // response or a log line's structured fields.
    let preceding = lines[..struct_line]
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap();
    assert!(
        !preceding.trim_start().starts_with("#[derive"),
        "PrivateKey appears to have a #[derive(...)] attribute, which could auto-implement Debug/Serialize: {preceding}",
    );

    assert!(
        contents.contains("impl fmt::Debug for PrivateKey"),
        "PrivateKey must have a hand-written, redacting Debug impl",
    );
}
