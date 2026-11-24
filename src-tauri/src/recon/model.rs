use chrono::Utc;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconEntity {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub attributes: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconRelationship {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub label: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconEvidence {
    pub id: String,
    pub provider: String,
    pub evidence_type: String,
    pub query: String,
    pub retrieved_at: String,
    pub observed_at: Option<String>,
    pub status: String,
    pub source_ref: Option<String>,
    pub original_value: Option<String>,
    pub normalized_value: Option<String>,
    pub details: Value,
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconEvent {
    pub job_id: String,
    pub sequence: u64,
    pub timestamp: String,
    pub phase: String,
    pub provider: Option<String>,
    pub kind: String,
    pub status: Option<String>,
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<ReconEntity>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub relationships: Vec<ReconRelationship>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<ReconEvidence>,
}

impl ReconEvent {
    pub fn new(job_id: &str, sequence: u64, phase: &str, kind: &str) -> Self {
        Self {
            job_id: job_id.to_owned(),
            sequence,
            timestamp: Utc::now().to_rfc3339(),
            phase: phase.to_owned(),
            provider: None,
            kind: kind.to_owned(),
            status: None,
            message: None,
            entities: Vec::new(),
            relationships: Vec::new(),
            evidence: Vec::new(),
        }
    }
}

pub fn evidence(
    provider: &str,
    evidence_type: &str,
    query: &str,
    status: &str,
    source_ref: Option<String>,
    original_value: Option<String>,
    normalized_value: Option<String>,
    details: Value,
    limitations: Vec<String>,
) -> ReconEvidence {
    let retrieved_at = Utc::now().to_rfc3339();
    let identity = normalized_value
        .as_deref()
        .or(original_value.as_deref())
        .unwrap_or(status);
    let detail_identity = ["recordType", "certificateId"]
        .iter()
        .filter_map(|key| details.get(*key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(":");
    let identity = if detail_identity.is_empty() {
        identity.to_owned()
    } else {
        format!("{identity}:{detail_identity}")
    };
    ReconEvidence {
        id: format!("ev:{provider}:{evidence_type}:{query}:{identity}"),
        provider: provider.to_owned(),
        evidence_type: evidence_type.to_owned(),
        query: query.to_owned(),
        retrieved_at,
        observed_at: None,
        status: status.to_owned(),
        source_ref,
        original_value,
        normalized_value,
        details,
        limitations,
    }
}

#[cfg(test)]
mod tests {
    use super::evidence;
    use serde_json::json;

    #[test]
    fn evidence_identity_stays_stable_and_distinguishes_certificates_and_dns_types() {
        let first = evidence(
            "ct",
            "certificateName",
            "example.com",
            "historical",
            None,
            Some("mail.example.com".to_owned()),
            Some("mail.example.com".to_owned()),
            json!({"certificateId":"1001"}),
            vec![],
        );
        let same_observation = evidence(
            "ct",
            "certificateName",
            "example.com",
            "historical",
            None,
            Some("mail.example.com".to_owned()),
            Some("mail.example.com".to_owned()),
            json!({"certificateId":"1001"}),
            vec![],
        );
        let different_certificate = evidence(
            "ct",
            "certificateName",
            "example.com",
            "historical",
            None,
            Some("mail.example.com".to_owned()),
            Some("mail.example.com".to_owned()),
            json!({"certificateId":"1002"}),
            vec![],
        );
        let a = evidence(
            "dns",
            "resourceRecord",
            "example.com",
            "observed",
            None,
            Some("192.0.2.1".to_owned()),
            Some("192.0.2.1".to_owned()),
            json!({"recordType":"A"}),
            vec![],
        );
        let aaaa = evidence(
            "dns",
            "resourceRecord",
            "example.com",
            "observed",
            None,
            Some("192.0.2.1".to_owned()),
            Some("192.0.2.1".to_owned()),
            json!({"recordType":"AAAA"}),
            vec![],
        );
        assert_eq!(first.id, same_observation.id);
        assert_ne!(first.id, different_certificate.id);
        assert_ne!(a.id, aaaa.id);
    }
}
