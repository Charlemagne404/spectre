use std::collections::BTreeMap;

use serde_json::{json, Value};
use url::Url;

use crate::recon::model::{evidence, ReconEntity, ReconEvent, ReconRelationship};
use crate::recon::providers::common::{
    emit, get_json, provider_error, provider_state, ProviderContext,
};

const MAX_CANDIDATES: usize = 160;

fn scoped_name(name: &str, scope: &str) -> Option<(String, bool)> {
    let name = name.trim().trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() || name.len() > 253 || name.chars().any(char::is_whitespace) {
        return None;
    }
    let wildcard = name.starts_with("*.");
    let base = if wildcard { &name[2..] } else { name.as_str() };
    let ascii = idna::domain_to_ascii(base).ok()?.to_ascii_lowercase();
    if ascii != scope && !ascii.ends_with(&format!(".{scope}")) {
        return None;
    }
    if ascii.split('.').any(|label| {
        label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
    }) {
        return None;
    }
    Some((
        if wildcard {
            format!("*.{ascii}")
        } else {
            ascii
        },
        wildcard,
    ))
}

pub fn extract_candidates(
    rows: &Value,
    scope: &str,
) -> Vec<(
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
)> {
    let mut candidates =
        BTreeMap::<(String, String), (Option<String>, Option<String>, Option<String>)>::new();
    let Some(rows) = rows.as_array() else {
        return Vec::new();
    };
    for row in rows.iter().take(2_000) {
        let id = row
            .get("id")
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
            .or_else(|| {
                row.get("id")
                    .and_then(Value::as_str)
                    .map(|value| value.chars().take(80).collect::<String>())
            });
        let Some(id) = id else { continue };
        let valid_from = row
            .get("not_before")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(64).collect());
        let valid_to = row
            .get("not_after")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(64).collect());
        let issuer = row
            .get("issuer_name")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(180).collect());
        let names = row
            .get("name_value")
            .and_then(Value::as_str)
            .into_iter()
            .chain(row.get("common_name").and_then(Value::as_str));
        for value in names {
            for name in value.lines().flat_map(|line| line.split(',')) {
                if let Some((candidate, _wildcard)) = scoped_name(name, scope) {
                    candidates
                        .entry((candidate, id.clone()))
                        .or_insert_with(|| (valid_from.clone(), valid_to.clone(), issuer.clone()));
                    if candidates.len() >= MAX_CANDIDATES {
                        break;
                    }
                }
            }
        }
        if candidates.len() >= MAX_CANDIDATES {
            break;
        }
    }
    candidates
        .into_iter()
        .map(|((name, id), (from, to, issuer))| (name, id, from, to, issuer))
        .collect()
}

pub async fn collect(context: &ProviderContext) {
    provider_state(context, "ct", "running", None).await;
    let mut url = Url::parse("https://crt.sh/").expect("fixed CT URL is valid");
    url.query_pairs_mut()
        .append_pair("q", &format!("%.{}", context.target.hostname))
        .append_pair("output", "json");
    let rows = match get_json(context, url.clone()).await {
        Ok(value) => value,
        Err(error) => {
            if error != "Cancelled" {
                provider_error(context, "ct", error).await;
            }
            return;
        }
    };
    let candidates = extract_candidates(&rows, &context.target.hostname);
    if candidates.is_empty() {
        provider_state(
            context,
            "ct",
            "complete",
            Some("The provider returned no in-scope certificate names.".to_owned()),
        )
        .await;
        return;
    }

    let mut event = ReconEvent::new(&context.job_id, 0, "ct", "finding");
    event.provider = Some("ct".to_owned());
    for (name, certificate_id, valid_from, valid_to, issuer) in candidates {
        let wildcard = name.starts_with("*.");
        let host = if wildcard {
            name.trim_start_matches("*.")
        } else {
            name.as_str()
        };
        let entity_id = format!("{}:{host}", if wildcard { "wildcard" } else { "hostname" });
        event.entities.push(ReconEntity {
            id: entity_id.clone(),
            kind: if wildcard { "wildcard" } else { "hostname" }.to_owned(),
            label: name.clone(),
            attributes: json!({"evidenceState":"historicallyObserved","currentResolution":"unverified"}),
        });
        let evidence_item = evidence(
            "ct", "certificateName", &context.target.hostname, if wildcard { "wildcard" } else { "historical" },
            Some(format!("https://crt.sh/?id={certificate_id}")), Some(name.clone()), Some(name.clone()),
            json!({"certificateId":certificate_id,"validFrom":valid_from,"validTo":valid_to,"issuer":issuer,"index":"crt.sh"}),
            vec!["Certificate Transparency records are historical observations and do not establish current DNS resolution, ownership, or authorization to probe the name.".to_owned()],
        );
        let evidence_id = evidence_item.id.clone();
        event.evidence.push(evidence_item);
        event.relationships.push(ReconRelationship {
            id: format!(
                "rel:ct:{}:{host}",
                if wildcard { "wildcard" } else { "hostname" }
            ),
            from: format!("domain:{}", context.target.hostname),
            to: entity_id,
            kind: if wildcard {
                "certificateWildcard"
            } else {
                "certificateObserved"
            }
            .to_owned(),
            label: if wildcard {
                "wildcard certificate for"
            } else {
                "certificate observed"
            }
            .to_owned(),
            evidence_ids: vec![evidence_id],
        });
    }
    emit(context, event).await;
    provider_state(context, "ct", "complete", None).await;
}

#[cfg(test)]
mod tests {
    use super::extract_candidates;
    use serde_json::json;

    #[test]
    fn ct_names_are_deduplicated_scoped_and_wildcards_stay_unverified() {
        let rows = json!([
            {"id":1,"name_value":"mail.example.com\n*.example.com\nnotexample.com","not_before":"2025-01-01"},
            {"id":2,"common_name":"MAIL.EXAMPLE.COM","issuer_name":"Example CA"},
            {"id":3,"name_value":"*.other.example.com"},
            {"id":4,"name_value":"www.example.net"}
        ]);
        let candidates = extract_candidates(&rows, "example.com");
        assert!(candidates
            .iter()
            .any(|(name, _, _, _, _)| name == "mail.example.com"));
        assert!(candidates
            .iter()
            .any(|(name, _, _, _, _)| name == "*.example.com"));
        assert!(candidates
            .iter()
            .any(|(name, _, _, _, _)| name == "*.other.example.com"));
        assert!(!candidates
            .iter()
            .any(|(name, _, _, _, _)| name == "notexample.com" || name == "www.example.net"));
    }
}
