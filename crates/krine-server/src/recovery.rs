//! Explicit host recovery. This command never starts HTTP, migrates storage or
//! prints a token. The new private file is the sole delivery channel.
use crate::{
    config::Config,
    operators::{self, Audit, Identity},
    util,
};
use sqlx::{Row, postgres::PgPoolOptions};
use std::{io::Write, path::Path, time::Duration};

pub async fn arm(
    config: Config,
    installation_id: &str,
    output: &Path,
    reason: &str,
) -> Result<(), String> {
    if reason.is_empty()
        || reason.len() > 512
        || reason.trim() != reason
        || reason.chars().any(char::is_control)
    {
        return Err("A recovery reason must contain 1–512 bytes without control characters or surrounding whitespace.".into());
    }
    if installation_id.len() > 128 || !installation_id.starts_with("installation_") {
        return Err("Provide the expected installation ID from the sign-in page.".into());
    }
    let mut file = private_file(output)?;
    let result = arm_with_file(config, installation_id, reason, &mut file).await;
    if result.is_err() && file.metadata().is_ok_and(|m| m.len() == 0) {
        drop(file);
        let _ = std::fs::remove_file(output);
    }
    result
}
#[cfg(unix)]
fn private_file(path: &Path) -> Result<std::fs::File, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("Use an absolute path in a private directory.")?;
    if !path.is_absolute() {
        return Err("Use an absolute path in a private directory.".into());
    }
    let directory =
        std::fs::symlink_metadata(parent).map_err(|_| "Cannot inspect the recovery directory.")?;
    if !directory.is_dir() || directory.mode() & 0o077 != 0 {
        return Err("The recovery directory must be private (mode 0700).".into());
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| "Cannot exclusively create the recovery file; choose a new filename.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect the recovery file.")?;
    if directory.uid() != metadata.uid() || metadata.nlink() != 1 || metadata.mode() & 0o077 != 0 {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err("The recovery directory must belong to the command's operator.".into());
    }
    Ok(file)
}
#[cfg(not(unix))]
fn private_file(_: &Path) -> Result<std::fs::File, String> {
    Err("Recovery file creation requires a Unix host with owner-only file permissions.".into())
}
async fn arm_with_file(
    config: Config,
    installation_id: &str,
    reason: &str,
    file: &mut std::fs::File,
) -> Result<(), String> {
    let db = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(2))
        .after_connect(|c, _| {
            Box::pin(async move {
                for query in [
                    "SET krine.writer_generation='6'",
                    "SET statement_timeout='3s'",
                    "SET lock_timeout='1s'",
                ] {
                    sqlx::query(query).execute(&mut *c).await?;
                }
                Ok(())
            })
        })
        .connect(&config.database_url)
        .await
        .map_err(|_| "Cannot connect to the configured installation database.")?;
    let result:crate::error::Result<()>=async {
        let migrations=sqlx::migrate!("../../migrations");
        let rows=sqlx::query("SELECT version,checksum,success FROM _sqlx_migrations ORDER BY version").fetch_all(&db).await?;
        if rows.len()!=migrations.iter().count() || rows.iter().zip(migrations.iter()).any(|(row,migration)| {
            !row.get::<bool,_>("success") || row.get::<i64,_>("version")!=migration.version || row.get::<Vec<u8>,_>("checksum").as_slice()!=migration.checksum.as_ref()
        }) {return Err(crate::error::ApiError::invalid("Recovery requires the matching operator-access schema."));}
        let mut tx=db.begin().await?;operators::gate(&mut tx,true).await?;
        let row=sqlx::query("SELECT installation_id,installation_secret_digest,bootstrap_consumed_at FROM operator_access WHERE singleton").fetch_one(&mut *tx).await?;
        if row.get::<Option<i64>,_>("bootstrap_consumed_at").is_none() || row.get::<String,_>("installation_id")!=installation_id || !util::equal(&row.get::<String,_>("installation_secret_digest"),&util::digest(format!("krine.installation.v1\0{}",config.admin_password))){return Err(crate::error::ApiError::unauthorized());}
        let at=operators::now(&mut tx).await?;let id=util::token("recovery_");let token=util::token("rg_");
        sqlx::query("UPDATE operator_recovery_grants SET revoked_at=COALESCE(revoked_at,$1)").bind(at).execute(&mut *tx).await?;
        sqlx::query("UPDATE operator_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE recovery_grant_id IS NOT NULL").bind(at).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO operator_recovery_grants(id,digest,reason,created_at,expires_at) VALUES($1,$2,$3,$4,$5)")
            .bind(&id).bind(util::digest(format!("krine.recovery.v1\0{token}"))).bind(reason).bind(at).bind(at+15*60_000).execute(&mut *tx).await?;
        operators::record(&mut tx,&Identity{id:"installation_configuration".into(),kind:"installation_configuration".into(),name:"Installation configuration".into()},Audit::new("recovery.arm","recovery_grant",&id).reason(reason),None).await?;
        // Flush the only reveal before committing. A commit-acknowledgement loss
        // preserves the file: deleting it could discard a live recovery grant.
        file.write_all(format!("{token}\n").as_bytes()).map_err(|_|crate::error::ApiError::unavailable())?;
        file.sync_all().map_err(|_|crate::error::ApiError::unavailable())?;
        tx.commit().await?;Ok(())
    }.await;
    db.close().await;
    result.map_err(|_|"Recovery could not be armed. Check the installation ID, owner secret and matching schema. A file containing a token may represent an uncertain commit; redeem it or arm a new grant deliberately.".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn recovery_file_is_exclusive_private_and_never_follows_a_final_symlink() {
        let directory = std::env::temp_dir().join(util::token("krine-recovery-file-test-"));
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("grant");
        let mut file = private_file(&path).unwrap();
        file.write_all(b"keep this content").unwrap();
        drop(file);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(private_file(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"keep this content");
        let link = directory.join("link");
        symlink(&path, &link).unwrap();
        assert!(private_file(&link).is_err());
        assert!(private_file(Path::new("relative-output")).is_err());
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(private_file(&directory.join("unsafe")).is_err());
        std::fs::remove_file(link).unwrap();
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
