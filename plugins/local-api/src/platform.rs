//! Explicit meeting handoff to agent-platform. Credentials and signing stay native.
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use tauri::Manager;

const TARGETS: [(&str, &str, &str); 3] = [
    (
        "james",
        "James",
        "https://jason-workspace.vercel.app/jason/ingest/company",
    ),
    (
        "arkenza",
        "Arkenza",
        "https://fluency-workspace.vercel.app/fluency/ingest/company",
    ),
    (
        "kim",
        "Kim",
        "https://roccio-kim.vercel.app/kim/ingest/company",
    ),
];
static SEND_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(serde::Serialize, serde::Deserialize)]
struct Config {
    endpoint: String,
    secret: String,
}
#[derive(serde::Serialize, serde::Deserialize)]
struct Delivery {
    target: String,
    endpoint: String,
    payload: serde_json::Value,
    receipt: Option<serde_json::Value>,
}

fn target(id: &str) -> Result<(&'static str, &'static str, &'static str), String> {
    TARGETS
        .iter()
        .copied()
        .find(|t| t.0 == id)
        .ok_or_else(|| "Unknown agent.".into())
}
fn directory<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot find app configuration.")?
        .join("agent-platform");
    std::fs::create_dir_all(&path).map_err(|_| "Cannot create app configuration.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect app configuration.")?;
    }
    Ok(path)
}
fn write_private(path: &std::path::Path, value: &impl serde::Serialize) -> Result<(), String> {
    use std::io::Write;
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot encode configuration.")?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temp)
            .map_err(|_| "Cannot save configuration.")?;
        file.write_all(&bytes)
            .map_err(|_| "Cannot save configuration.")?;
        file.sync_all().map_err(|_| "Cannot save configuration.")?;
        std::fs::rename(&temp, path).map_err(|_| "Cannot save configuration.")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result.map_err(str::to_owned)
}
fn read_config(path: &std::path::Path) -> Result<Config, String> {
    let bytes = std::fs::read(path)
        .map_err(|_| "Configure this agent's endpoint and signing key first.")?;
    serde_json::from_slice(&bytes).map_err(|_| "Agent configuration is invalid.".into())
}
fn validate_endpoint(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Enter an HTTPS ingestion endpoint.")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().ends_with("/ingest/company")
    {
        return Err(
            "Use an HTTPS URL ending in /ingest/company without credentials or query parameters."
                .into(),
        );
    }
    let host = url.host_str().unwrap_or_default();
    if [
        "anarlog.so",
        "hyprnote.com",
        "hyprnote.so",
        "fastrepl.com",
        "char.com",
        "posthog.com",
        "sentry.io",
    ]
    .iter()
    .any(|base| host == *base || host.ends_with(&format!(".{base}")))
    {
        return Err("Upstream service endpoints are unavailable in this fork.".into());
    }
    Ok(())
}
fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn signature(secret: &str, timestamp: &str, body: &str) -> String {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).expect("HMAC key length");
    mac.update(format!("{timestamp}.{body}").as_bytes());
    format!(
        "sha256={}",
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}
fn meeting_payload(
    export: &anlg_agent_access::MeetingExport,
    recipient: &str,
) -> Result<serde_json::Value, String> {
    if export.transcripts.iter().all(|t| t.text.trim().is_empty()) {
        return Err("This meeting has no transcript yet. Wait for transcription to finish.".into());
    }
    let text = export.to_markdown();
    if text.encode_utf16().count() > 250_000 {
        return Err(
            "This meeting exceeds the platform's text limit. Export a shorter transcript first."
                .into(),
        );
    }
    let date = [&export.meeting.started_at, &export.meeting.created_at]
        .iter()
        .find_map(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|d| d.to_utc())
                .or_else(|| {
                    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                        .ok()
                        .and_then(|d| d.and_hms_opt(0, 0, 0))
                        .map(|d| d.and_utc())
                })
        })
        .ok_or_else(|| "The meeting date is invalid.".to_string())?;
    let title: String = export.meeting.title.trim().chars().take(250).collect();
    let mut payload = serde_json::json!({
        "kind": "transcript", "occurredAt": date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "title": if title.is_empty() { "Untitled meeting" } else { &title }, "text": text,
        "author": "Anarlog Platform", "conversationId": format!("anarlog:{}", export.meeting.id),
        "metadata": { "provider": "anarlog", "meetingId": export.meeting.id, "targetAgent": recipient, "contentFormat": "markdown" }
    });
    let id = format!("anarlog:{}", digest(&format!("{recipient}\0{payload}")));
    payload["id"] = id.into();
    if payload.to_string().len() > 600_000 {
        return Err("This meeting exceeds the platform's request size limit.".into());
    }
    Ok(payload)
}

#[tauri::command]
#[specta::specta]
pub async fn platform_targets<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let dir = directory(&app)?;
    Ok(serde_json::Value::Array(TARGETS.iter().map(|(id,name,endpoint)| {
        let config = read_config(&dir.join(format!("{id}.json"))).ok();
        serde_json::json!({"id": id,"name": name,"endpoint": config.as_ref().map(|c| c.endpoint.as_str()).unwrap_or(endpoint),"configured": config.is_some()})
    }).collect()))
}
#[tauri::command]
#[specta::specta]
pub async fn configure_platform_target<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    agent: String,
    endpoint: String,
    secret: String,
) -> Result<(), String> {
    target(&agent)?;
    validate_endpoint(&endpoint)?;
    if secret.len() < 16 || secret.len() > 4096 {
        return Err("Use the instance's ingestion signing key (at least 16 characters).".into());
    }
    let _guard = SEND_LOCK.lock().await;
    write_private(
        &directory(&app)?.join(format!("{agent}.json")),
        &Config { endpoint, secret },
    )
}
#[tauri::command]
#[specta::specta]
pub async fn preview_platform_meeting<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    agent: String,
    meeting_id: String,
) -> Result<serde_json::Value, String> {
    target(&agent)?;
    let _guard = SEND_LOCK.lock().await;
    let dir = directory(&app)?;
    let config = read_config(&dir.join(format!("{agent}.json")))?;
    validate_endpoint(&config.endpoint)?;
    let pool = app
        .try_state::<tauri_plugin_db::ManagedState>()
        .ok_or("Database is not ready.")?
        .pool()
        .clone();
    let export = anlg_agent_access::get_meeting_export(&pool, meeting_id)
        .await
        .map_err(|_| "Cannot export this meeting.")?;
    let payload = meeting_payload(&export, &agent)?;
    let id = payload["id"]
        .as_str()
        .ok_or("Invalid export ID.")?
        .trim_start_matches("anarlog:")
        .to_string();
    let path = dir.join(format!("delivery-{id}.json"));
    let existing = std::fs::read(&path)
        .ok()
        .and_then(|s| serde_json::from_slice::<Delivery>(&s).ok());
    let receipt = existing
        .filter(|d| d.endpoint == config.endpoint)
        .and_then(|d| d.receipt);
    write_private(
        &path,
        &Delivery {
            target: agent.clone(),
            endpoint: config.endpoint.clone(),
            payload: payload.clone(),
            receipt: receipt.clone(),
        },
    )?;
    Ok(
        serde_json::json!({"deliveryId": id,"agent": agent,"endpoint": config.endpoint,"payload": payload,"receipt": receipt}),
    )
}
#[tauri::command]
#[specta::specta]
pub async fn send_platform_meeting<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    delivery_id: String,
) -> Result<serde_json::Value, String> {
    if delivery_id.len() != 64 || !delivery_id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid delivery ID.".into());
    }
    let _guard = SEND_LOCK.lock().await;
    let dir = directory(&app)?;
    let path = dir.join(format!("delivery-{delivery_id}.json"));
    let mut delivery: Delivery =
        serde_json::from_slice(&std::fs::read(&path).map_err(|_| "Preview this meeting first.")?)
            .map_err(|_| "Saved delivery is invalid.")?;
    target(&delivery.target)?;
    if let Some(receipt) = &delivery.receipt {
        return Ok(receipt.clone());
    }
    let config = read_config(&dir.join(format!("{}.json", delivery.target)))?;
    if config.endpoint != delivery.endpoint {
        return Err("The endpoint changed. Preview this meeting again before sending.".into());
    }
    validate_endpoint(&config.endpoint)?;
    let body = delivery.payload.to_string();
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "Cannot create delivery client.")?;
    let response = client
        .post(&config.endpoint)
        .header("content-type", "application/json")
        .header("x-company-timestamp", &timestamp)
        .header(
            "x-company-signature",
            signature(&config.secret, &timestamp, &body),
        )
        .body(body)
        .send()
        .await
        .map_err(|_| "Delivery could not be confirmed. The saved meeting can be retried safely.")?;
    if response.status().as_u16() != 202 {
        return Err(format!(
            "Platform returned HTTP {}. The saved meeting can be retried safely.",
            response.status().as_u16()
        ));
    }
    let receipt: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "The platform receipt is unreadable. Retry the saved meeting.")?;
    if receipt["recorded"] != true
        || !receipt["artifactId"].is_string()
        || !receipt["eventId"].is_string()
    {
        return Err("The platform did not confirm ingestion. Retry the saved meeting.".into());
    }
    delivery.receipt = Some(receipt.clone());
    write_private(&path, &delivery)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signatures_bind_exact_json_and_timestamp() {
        assert_eq!(
            signature("test-secret", "1791700000", "{\"text\":\"hello\"}"),
            "sha256=00ef102a9a7f89e72590c1b06f6290d25829e4a003a9939d0716e514a39a5f13"
        );
        assert_ne!(
            signature("test-secret", "1791700001", "{\"text\":\"hello\"}"),
            signature("test-secret", "1791700000", "{\"text\":\"hello\"}")
        );
    }
    #[tokio::test]
    async fn reviewed_export_retries_deduplicate_and_edits_create_new_revisions() {
        let pool = crate::test::seeded_pool().await;
        let mut export = anlg_agent_access::get_meeting_export(&pool, "meeting-1".into())
            .await
            .unwrap();
        let original = meeting_payload(&export, "james").unwrap();
        assert_eq!(original, meeting_payload(&export, "james").unwrap());
        assert_eq!(original["occurredAt"], "2026-07-13T00:00:00.000Z");
        assert!(original["text"].as_str().unwrap().contains("hello world"));
        assert!(
            original["text"]
                .as_str()
                .unwrap()
                .contains("Launch decision")
        );
        assert_ne!(
            original["id"],
            meeting_payload(&export, "kim").unwrap()["id"]
        );
        export.transcripts[0].text.push_str(" corrected");
        assert_ne!(
            original["id"],
            meeting_payload(&export, "james").unwrap()["id"]
        );
        export.transcripts.clear();
        assert!(meeting_payload(&export, "james").is_err());
    }

    #[test]
    fn endpoints_cannot_redirect_credentials_to_upstream_services() {
        assert!(validate_endpoint(TARGETS[0].2).is_ok());
        for url in [
            "http://example.com/ingest/company",
            "https://user:pass@example.com/ingest/company",
            "https://example.com/ingest/company?q=secret",
            "https://api.anarlog.so/ingest/company",
        ] {
            assert!(validate_endpoint(url).is_err());
        }
    }
}
