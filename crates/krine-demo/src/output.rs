use crate::{Configuration, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chunk {
    pub name: String,
    pub store: String,
    pub table: String,
    pub sha256: String,
    pub bytes: u64,
    pub rows: u64,
}
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub dataset_id: String,
    pub configuration: Configuration,
    pub from: i64,
    pub to: i64,
    pub bytes: u64,
    pub counts: BTreeMap<String, u64>,
    pub chunks: Vec<Chunk>,
    pub scenarios: Vec<Value>,
}
pub struct Output {
    directory: PathBuf,
    _lock: File,
    verify: bool,
    manifest: Manifest,
    buffer: Vec<u8>,
    rows: u64,
    current: Option<(String, String)>,
}
impl Output {
    pub fn open(directory: PathBuf, configuration: Configuration, verify: bool) -> Result<Self> {
        if !directory.exists() {
            if verify {
                return Err("Dataset directory does not exist".into());
            }
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            builder.mode(0o700);
            builder.create(&directory)?;
        }
        if fs::symlink_metadata(&directory)?.file_type().is_symlink() || !directory.is_dir() {
            return Err("Dataset directory must be an ordinary directory".into());
        }
        let lock_path = directory.join(".generator.lock");
        if lock_path
            .symlink_metadata()
            .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
        {
            return Err("Unsafe generator lock".into());
        }
        let mut options = OpenOptions::new();
        options.create(true).write(true).truncate(false);
        #[cfg(unix)]
        options.mode(0o600);
        let lock = options.open(lock_path)?;
        lock.try_lock()
            .map_err(|_| "Another process owns this dataset directory")?;
        let config_path = directory.join("dataset.json");
        if !config_path.exists()
            && fs::read_dir(&directory)?.filter_map(|v| v.ok()).any(|v| {
                v.file_name() != ".generator.lock" && v.file_name() != ".dataset.json.partial"
            })
        {
            return Err(
                "Refuse an existing directory without this dataset's ownership configuration"
                    .into(),
            );
        }
        let dataset_id = configuration.id()?;
        let mut instance = Self {
            directory,
            _lock: lock,
            verify,
            manifest: Manifest {
                schema_version: 1,
                dataset_id,
                from: configuration.anchor_ms - 28 * crate::DAY,
                to: configuration.anchor_ms - 600_000,
                configuration,
                bytes: 0,
                counts: BTreeMap::new(),
                chunks: Vec::new(),
                scenarios: Vec::new(),
            },
            buffer: Vec::new(),
            rows: 0,
            current: None,
        };
        instance.file(
            "dataset.json",
            &serde_json::to_vec_pretty(&instance.manifest.configuration)?,
        )?;
        Ok(instance)
    }
    fn file(&mut self, name: &str, bytes: &[u8]) -> Result<()> {
        let path = self.directory.join(name);
        if let Ok(metadata) = path.symlink_metadata() {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() != bytes.len() as u64
                || fs::read(&path)? != bytes
            {
                return Err(format!("Existing artifact differs or is unsafe: {name}").into());
            }
            return Ok(());
        }
        if self.verify {
            return Err(format!("Missing artifact: {name}").into());
        }
        let temp = self.directory.join(format!(".{name}.partial"));
        // A complete chunk is synced before publication. Incomplete owned temporary files may be replaced.
        if temp.exists() {
            if temp.symlink_metadata()?.file_type().is_symlink() {
                return Err("Unsafe partial artifact".into());
            }
            fs::remove_file(&temp)?;
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(temp, path)?;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
    pub fn row(&mut self, store: &str, table: &str, value: Value) -> Result<()> {
        let key = (store.to_owned(), table.to_owned());
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("One fixture record exceeds its byte budget".into());
        }
        if self.current.as_ref().is_some_and(|current| current != &key)
            || self.rows >= 500
            || self.buffer.len() + bytes.len() > 2 * 1024 * 1024
        {
            self.flush()?;
        }
        self.current = Some(key);
        if self.manifest.bytes + self.buffer.len() as u64 + bytes.len() as u64
            > self.manifest.configuration.max_bytes
        {
            return Err("Dataset exceeds --max-bytes; partial owned chunks are preserved".into());
        }
        self.count(format!("rows/{store}/{table}"));
        self.buffer.extend(bytes);
        self.rows += 1;
        Ok(())
    }
    fn flush(&mut self) -> Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let (store, table) = self.current.take().ok_or("Missing chunk kind")?;
        let bytes = std::mem::take(&mut self.buffer);
        let name = format!("chunk-{:06}.jsonl", self.manifest.chunks.len());
        self.file(&name, &bytes)?;
        self.manifest.bytes += bytes.len() as u64;
        self.manifest.chunks.push(Chunk {
            name,
            store,
            table,
            sha256: digest(&bytes),
            bytes: bytes.len() as u64,
            rows: self.rows,
        });
        self.rows = 0;
        Ok(())
    }
    pub fn count(&mut self, key: impl Into<String>) {
        *self.manifest.counts.entry(key.into()).or_default() += 1;
    }
    pub fn scenario(&mut self, value: Value) {
        self.manifest.scenarios.push(value);
    }
    pub fn marker(&self) -> Value {
        json!({"dataset_id":self.manifest.dataset_id,"generator_version":self.manifest.configuration.generator_version})
    }
    pub fn finish(mut self) -> Result<Manifest> {
        self.flush()?;
        self.file("manifest.json", &serde_json::to_vec_pretty(&self.manifest)?)?;
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_str().ok_or("Non-UTF8 artifact name")?;
            if ![".generator.lock", "dataset.json", "manifest.json"].contains(&name)
                && !self.manifest.chunks.iter().any(|chunk| chunk.name == name)
            {
                return Err(format!("Unexpected dataset artifact: {name}").into());
            }
        }
        Ok(self.manifest)
    }
}
