mod dataset;
mod output;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const VERSION: &str = "1";
const DAY: i64 = 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    generator_version: String,
    seed: String,
    anchor_ms: i64,
    users: usize,
    attempts: usize,
    max_bytes: u64,
}
impl Configuration {
    fn validate(&self) -> Result<()> {
        if self.generator_version != VERSION
            || self.seed.is_empty()
            || self.seed.len() > 128
            || !self.seed.bytes().all(|b| b.is_ascii_graphic())
            || !(DAY * 60..=8_640_000_000_000_000 - DAY).contains(&self.anchor_ms)
            || !(40..=20_000).contains(&self.users)
            || !(200..=100_000).contains(&self.attempts)
            || self.attempts < self.users * 5
            || !(1_048_576..=2_147_483_648).contains(&self.max_bytes)
        {
            return Err("Invalid dataset configuration or resource bound".into());
        }
        Ok(())
    }
    fn id(&self) -> Result<String> {
        // Storage budget does not change logical facts, but resume pins the full configuration.
        let identity = serde_json::json!({"generator_version":self.generator_version,"seed":self.seed,"anchor_ms":self.anchor_ms,"users":self.users,"attempts":self.attempts});
        Ok(format!(
            "demo_{}",
            &output::digest(&serde_json::to_vec(&identity)?)[..24]
        ))
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("krine-demo: {error}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args
        .next()
        .ok_or("Use generate or verify; see docs/engineering/demo.md")?;
    let mut options = BTreeMap::new();
    while let Some(key) = args.next() {
        if !key.starts_with("--") || options.contains_key(&key) {
            return Err("Expected unique named options".into());
        }
        options.insert(key, args.next().ok_or("An option is missing its value")?);
    }
    let path = PathBuf::from(options.remove("--output").ok_or("--output is required")?);
    let verify = command == "verify";
    let config = if verify {
        let config_path = path.join("dataset.json");
        let metadata = config_path.symlink_metadata()?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return Err("Invalid dataset configuration file".into());
        }
        serde_json::from_slice(&std::fs::read(config_path)?)?
    } else if command == "generate" {
        let profile = options
            .remove("--profile")
            .unwrap_or_else(|| "standard".into());
        let scale: usize = options
            .remove("--scale")
            .unwrap_or_else(|| "1".into())
            .parse()?;
        if !(1..=10).contains(&scale) {
            return Err("--scale must be between 1 and 10".into());
        }
        let (users, attempts) = match profile.as_str() {
            "ci" => (40 * scale, 200 * scale),
            "standard" => (2000 * scale, 10_000 * scale),
            _ => return Err("--profile must be ci or standard".into()),
        };
        Configuration {
            generator_version: VERSION.into(),
            seed: options
                .remove("--seed")
                .unwrap_or_else(|| "krine-demo-v1".into()),
            anchor_ms: options
                .remove("--anchor-ms")
                .ok_or("--anchor-ms must explicitly pin the dataset's UTC clock")?
                .parse()?,
            users,
            attempts,
            max_bytes: options
                .remove("--max-bytes")
                .unwrap_or_else(|| "536870912".into())
                .parse()?,
        }
    } else {
        return Err("Use generate or verify".into());
    };
    if !options.is_empty() {
        return Err("Unknown options".into());
    }
    config.validate()?;
    let mut output = output::Output::open(path, config.clone(), verify)?;
    dataset::generate(&config, &mut output)?;
    let manifest = output.finish()?;
    println!(
        "{}: {} logical events, {} logical decisions, {} bytes{}",
        manifest.dataset_id,
        manifest.counts.get("history/event").unwrap_or(&0),
        manifest.counts.get("history/decision").unwrap_or(&0),
        manifest.bytes,
        if verify {
            " (regenerated and verified byte for byte)"
        } else {
            " (synthetic; not live-load evidence)"
        }
    );
    Ok(())
}
