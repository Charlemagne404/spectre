use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use hickory_resolver::TokioResolver;
use reqwest::{Client, StatusCode};
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::recon::{model::ReconEvent, target::NormalizedTarget};

pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(9);

#[derive(Clone)]
pub struct ProviderContext {
    pub job_id: String,
    pub target: NormalizedTarget,
    pub resolver: TokioResolver,
    pub requests: Arc<Semaphore>,
    pub cancel: CancellationToken,
    pub channel: Channel<ReconEvent>,
    pub sequence: Arc<AtomicU64>,
    pub event_lock: Arc<Mutex<()>>,
    pub provider_statuses: Arc<Mutex<HashMap<String, String>>>,
}

pub async fn emit(context: &ProviderContext, mut event: ReconEvent) {
    let _guard = context.event_lock.lock().await;
    event.sequence = context.sequence.fetch_add(1, Ordering::Relaxed) + 1;
    event.timestamp = chrono::Utc::now().to_rfc3339();
    if context.channel.send(event).is_err() {
        context.cancel.cancel();
    }
}

pub async fn provider_state(
    context: &ProviderContext,
    provider: &str,
    status: &str,
    message: Option<String>,
) {
    context
        .provider_statuses
        .lock()
        .await
        .insert(provider.to_owned(), status.to_owned());
    let mut event = ReconEvent::new(&context.job_id, 0, provider, "provider");
    event.provider = Some(provider.to_owned());
    event.status = Some(status.to_owned());
    event.message = message;
    emit(context, event).await;
}

pub async fn provider_error(context: &ProviderContext, provider: &str, message: String) {
    let status = classify_error(&message);
    provider_state(context, provider, status, Some(message)).await;
}

pub fn classify_error(message: &str) -> &'static str {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("rate limit") || normalized.contains("http 429") {
        "rateLimited"
    } else if normalized.contains("timed out") || normalized.contains("timeout") {
        "timeout"
    } else if normalized.contains("no connection")
        || normalized.contains("could not resolve host")
        || normalized.contains("no records found")
        || normalized.contains("failed to lookup")
        || normalized.contains("name or service not known")
        || normalized.contains("network is unreachable")
    {
        "offline"
    } else {
        "error"
    }
}

pub async fn phase(context: &ProviderContext, label: &str, status: &str) {
    let mut event = ReconEvent::new(&context.job_id, 0, label, "phase");
    event.status = Some(status.to_owned());
    emit(context, event).await;
}

pub async fn get_json(context: &ProviderContext, url: Url) -> Result<Value, String> {
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
    {
        return Err("Provider endpoint was not an HTTPS URL.".to_owned());
    }

    let permit = tokio::select! {
        _ = context.cancel.cancelled() => return Err("Cancelled".to_owned()),
        result = context.requests.clone().acquire_owned() => result.map_err(|_| "Provider request budget is closed.".to_owned())?,
    };
    let client = public_pinned_client(context, &url).await?;
    let result = request_json(context, &client, url).await;
    drop(permit);
    result
}

async fn request_json(
    context: &ProviderContext,
    client: &Client,
    url: Url,
) -> Result<Value, String> {
    for attempt in 0..=1 {
        let request = tokio::select! {
            _ = context.cancel.cancelled() => return Err("Cancelled".to_owned()),
            result = client.get(url.clone()).header(reqwest::header::ACCEPT, "application/rdap+json, application/json, */*;q=0.1").send() => result,
        };
        let request = match request {
            Ok(response) => response,
            Err(error) if attempt == 0 && (error.is_connect() || error.is_timeout()) => {
                tokio::select! {
                    _ = context.cancel.cancelled() => return Err("Cancelled".to_owned()),
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {},
                }
                continue;
            }
            Err(error) => return Err(request_error(&error)),
        };
        let status = request.status();
        if matches!(
            status,
            StatusCode::TOO_MANY_REQUESTS
                | StatusCode::BAD_GATEWAY
                | StatusCode::SERVICE_UNAVAILABLE
                | StatusCode::GATEWAY_TIMEOUT
        ) && attempt == 0
        {
            tokio::select! {
                _ = context.cancel.cancelled() => return Err("Cancelled".to_owned()),
                _ = tokio::time::sleep(Duration::from_millis(300)) => {},
            }
            continue;
        }
        if !status.is_success() {
            return Err(if status == StatusCode::TOO_MANY_REQUESTS {
                "Provider rate limit reached (HTTP 429). Retry this source later.".to_owned()
            } else {
                format!("Provider returned HTTP {}.", status.as_u16())
            });
        }
        if request
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err("Provider response exceeded the 2 MiB safety limit.".to_owned());
        }
        let mut response = request;
        let mut bytes = Vec::new();
        loop {
            let next = tokio::select! {
                _ = context.cancel.cancelled() => return Err("Cancelled".to_owned()),
                result = response.chunk() => result.map_err(|error| request_error(&error))?,
            };
            let Some(chunk) = next else { break };
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err("Provider response exceeded the 2 MiB safety limit.".to_owned());
            }
            bytes.extend_from_slice(&chunk);
        }
        return serde_json::from_slice(&bytes)
            .map_err(|_| "Provider returned malformed JSON.".to_owned());
    }
    Err("Provider request could not be completed.".to_owned())
}

pub fn bounded_error(message: &str) -> String {
    message.chars().take(240).collect()
}

fn request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "Provider request timed out.".to_owned()
    } else if error.is_connect() {
        "No connection to this provider. Check network connectivity, then retry.".to_owned()
    } else {
        bounded_error(&error.to_string())
    }
}

pub async fn public_pinned_client(context: &ProviderContext, url: &Url) -> Result<Client, String> {
    if url.scheme() != "https" || url.port().is_some_and(|port| port != 443) {
        return Err("Provider endpoint must use HTTPS on the standard port.".to_owned());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "RDAP endpoint has no hostname.".to_owned())?;
    if host.parse::<IpAddr>().is_ok()
        || host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return Err("RDAP endpoint hostname is not a public domain.".to_owned());
    }

    let lookup = tokio::select! {
        _ = context.cancel.cancelled() => return Err("Cancelled".to_owned()),
        result = tokio::time::timeout(REQUEST_TIMEOUT, context.resolver.lookup_ip(format!("{host}."))) => match result {
            Ok(Ok(lookup)) => lookup,
            Ok(Err(error)) => return Err(bounded_error(&error.to_string())),
            Err(_) => return Err("Provider hostname DNS lookup timed out.".to_owned()),
        },
    };
    let addresses = lookup
        .iter()
        .map(|address| SocketAddr::new(address, 443))
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses.len() > 32
        || addresses.iter().any(|address| !is_public_ip(address.ip()))
    {
        return Err(
            "Provider hostname resolved to a private, reserved, or excessive address set."
                .to_owned(),
        );
    }

    Client::builder()
        .no_proxy()
        .user_agent("Spectre-RECON/0.1 (passive public-data investigation)")
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|error| bounded_error(&error.to_string()))
}

pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            let (a, b, c) = (octets[0], octets[1], octets[2]);
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 88 && c == 99)
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            (segments[0] & 0xe000) == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] <= 0x01ff || segments[1] == 0x0db8))
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && (segments[1] & 0xfff0) == 0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_error, is_public_ip};
    use std::net::IpAddr;

    #[test]
    fn rejects_non_public_ipv4_and_ipv6_addresses() {
        for value in [
            "10.1.2.3",
            "127.0.0.1",
            "169.254.1.1",
            "100.64.1.1",
            "192.0.2.4",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2001:2::1",
            "2002::1",
            "3fff::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_public_ip(value.parse::<IpAddr>().unwrap()),
                "should reject {value}"
            );
        }
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
        assert!(is_public_ip("2001:4860:4860::8888".parse().unwrap()));
    }

    #[test]
    fn provider_failures_keep_offline_timeout_and_rate_limit_states_distinct() {
        assert_eq!(classify_error("No connection to this provider."), "offline");
        assert_eq!(classify_error("Provider request timed out."), "timeout");
        assert_eq!(
            classify_error("Provider rate limit reached (HTTP 429)."),
            "rateLimited"
        );
        assert_eq!(
            classify_error("No records found while resolving provider host."),
            "offline"
        );
    }
}
