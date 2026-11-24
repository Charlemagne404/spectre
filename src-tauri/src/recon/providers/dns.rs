use std::collections::HashSet;
use std::net::IpAddr;

use hickory_resolver::proto::rr::RecordType;
use serde_json::json;
use std::time::Duration;
use tokio::task::JoinSet;

use crate::recon::model::{evidence, ReconEntity, ReconEvent, ReconRelationship};
use crate::recon::providers::common::{emit, provider_state, ProviderContext};

const DNS_TYPES: [RecordType; 8] = [
    RecordType::A,
    RecordType::AAAA,
    RecordType::CNAME,
    RecordType::MX,
    RecordType::NS,
    RecordType::TXT,
    RecordType::SOA,
    RecordType::CAA,
];
const MAX_RECORDS_PER_TYPE: usize = 64;

#[derive(Clone, Debug)]
pub struct DnsSummary {
    pub public_ips: Vec<IpAddr>,
}

fn entity(id: String, kind: &str, label: String, attributes: serde_json::Value) -> ReconEntity {
    ReconEntity {
        id,
        kind: kind.to_owned(),
        label,
        attributes,
    }
}

fn relationship(
    id: String,
    from: &str,
    to: &str,
    kind: &str,
    label: String,
    evidence_id: &str,
) -> ReconRelationship {
    ReconRelationship {
        id,
        from: from.to_owned(),
        to: to.to_owned(),
        kind: kind.to_owned(),
        label,
        evidence_ids: vec![evidence_id.to_owned()],
    }
}

fn target_id(name: &str, root: &str) -> String {
    if name.eq_ignore_ascii_case(root) {
        format!("domain:{root}")
    } else {
        format!("hostname:{name}")
    }
}

fn canonical_name(value: &str) -> String {
    value.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn error_status(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("nxdomain") || normalized.contains("nameerror") {
        "nxdomain"
    } else if normalized.contains("noerror") || normalized.contains("no records found") {
        "nodata"
    } else if normalized.contains("servfail") {
        "servfail"
    } else if normalized.contains("timeout") {
        "timeout"
    } else {
        "error"
    }
}

pub async fn collect(context: &ProviderContext) -> DnsSummary {
    provider_state(context, "dns", "running", None).await;
    let target = context.target.hostname.clone();
    let root_id = format!("domain:{}", target);
    let mut initial = ReconEvent::new(&context.job_id, 0, "dns", "finding");
    initial.provider = Some("dns".to_owned());
    initial.entities.push(entity(
        root_id.clone(),
        "domain",
        target.clone(),
        json!({"scope":"explicitTarget"}),
    ));
    emit(context, initial).await;

    let mut tasks = JoinSet::new();
    for record_type in DNS_TYPES {
        let resolver = context.resolver.clone();
        let target = target.clone();
        let context = context.clone();
        tasks.spawn(async move {
            let permit = tokio::select! {
                _ = context.cancel.cancelled() => return (record_type, None),
                result = context.requests.clone().acquire_owned() => match result { Ok(permit) => permit, Err(_) => return (record_type, None) },
            };
            let answer = tokio::select! {
                _ = context.cancel.cancelled() => None,
                result = tokio::time::timeout(Duration::from_secs(9), resolver.lookup(format!("{target}."), record_type)) => Some(match result {
                    Ok(Ok(lookup)) => Ok(lookup),
                    Ok(Err(error)) => Err(format!("{error:?}")),
                    Err(_) => Err("DNS query timed out".to_owned()),
                }),
            };
            drop(permit);
            (record_type, answer)
        });
    }

    let mut public_ips = HashSet::new();
    let mut seen_records = HashSet::new();
    let mut successful = 0usize;
    let mut failures = 0usize;

    while let Some(joined) = tasks.join_next().await {
        if context.cancel.is_cancelled() {
            break;
        }
        let Ok((query_type, Some(answer))) = joined else {
            continue;
        };
        let record_type = query_type.to_string();
        match answer {
            Ok(lookup) => {
                let answer_records = lookup.answers();
                if answer_records.is_empty() {
                    let item = evidence("dns", "recordQuery", &target, "nodata", None, Some(record_type.clone()), None, json!({"recordType":record_type,"resolver":"system"}), vec!["No records of this type were returned; this is not evidence that the name never existed.".to_owned()]);
                    let mut event = ReconEvent::new(&context.job_id, 0, "dns", "finding");
                    event.provider = Some("dns".to_owned());
                    event.evidence.push(item);
                    emit(context, event).await;
                    successful += 1;
                    continue;
                }
                for record in answer_records.iter().take(MAX_RECORDS_PER_TYPE) {
                    let owner = canonical_name(&record.name.to_string());
                    let raw_value = record.data.to_string();
                    let identity =
                        format!("{}:{}:{}:{}", owner, record_type, raw_value, record.ttl);
                    if !seen_records.insert(identity.clone()) {
                        continue;
                    }
                    let value = raw_value.trim_end_matches('.').to_owned();
                    let evidence_item = evidence(
                        "dns", "resourceRecord", &owner, "observed", None, Some(raw_value.clone()), Some(value.clone()),
                        json!({"recordType":record_type,"ttlSeconds":record.ttl,"resolver":"system","queryName":target}),
                        vec!["DNS is a time-bounded public lookup through the operating-system configured resolver.".to_owned()],
                    );
                    let evidence_id = evidence_item.id.clone();
                    let mut event = ReconEvent::new(&context.job_id, 0, "dns", "finding");
                    event.provider = Some("dns".to_owned());
                    event.evidence.push(evidence_item);
                    let owner_id = target_id(&owner, &target);
                    if owner != target {
                        event.entities.push(entity(
                            owner_id.clone(),
                            "hostname",
                            owner.clone(),
                            json!({"recordOwner":true}),
                        ));
                    }
                    match query_type {
                        RecordType::A | RecordType::AAAA => {
                            if let Ok(address) = value.parse::<IpAddr>() {
                                let id = format!("ip:{address}");
                                event.entities.push(entity(id.clone(), "ip", address.to_string(), json!({"family": if address.is_ipv4() {"IPv4"} else {"IPv6"},"public":super::common::is_public_ip(address)})));
                                event.relationships.push(relationship(
                                    format!("rel:dns:{}:{}:{}", record_type, owner_id, id),
                                    &owner_id,
                                    &id,
                                    "resolvesTo",
                                    "resolves to".to_owned(),
                                    &evidence_id,
                                ));
                                if super::common::is_public_ip(address) {
                                    public_ips.insert(address);
                                }
                            }
                            ()
                        }
                        RecordType::CNAME => {
                            let host = canonical_name(&value);
                            if !host.is_empty() {
                                let id = format!("hostname:{host}");
                                event.entities.push(entity(
                                    id.clone(),
                                    "hostname",
                                    host,
                                    json!({"cnameTarget":true}),
                                ));
                                event.relationships.push(relationship(
                                    format!("rel:dns:cname:{}:{}", owner_id, id),
                                    &owner_id,
                                    &id,
                                    "cname",
                                    "CNAME".to_owned(),
                                    &evidence_id,
                                ));
                            }
                            ()
                        }
                        RecordType::MX => {
                            let (preference, exchange) = raw_value.split_once(' ').map_or(
                                (None, value.as_str()),
                                |(preference, exchange)| {
                                    (
                                        preference.parse::<u16>().ok(),
                                        exchange.trim_end_matches('.'),
                                    )
                                },
                            );
                            let host = canonical_name(exchange);
                            let id = format!("mailhost:{host}");
                            event.entities.push(entity(
                                id.clone(),
                                "mailhost",
                                host,
                                json!({"preference":preference}),
                            ));
                            event.relationships.push(relationship(
                                format!(
                                    "rel:dns:mx:{}:{}:{}",
                                    owner_id,
                                    id,
                                    preference.unwrap_or(0)
                                ),
                                &owner_id,
                                &id,
                                "usesMailExchanger",
                                format!(
                                    "MX preference {}",
                                    preference
                                        .map_or("—".to_owned(), |number| number.to_string())
                                ),
                                &evidence_id,
                            ));
                            ()
                        }
                        RecordType::NS => {
                            let host = canonical_name(&value);
                            let id = format!("nameserver:{host}");
                            event
                                .entities
                                .push(entity(id.clone(), "nameserver", host, json!({})));
                            event.relationships.push(relationship(
                                format!("rel:dns:ns:{}:{}", owner_id, id),
                                &owner_id,
                                &id,
                                "delegatedTo",
                                "delegated to".to_owned(),
                                &evidence_id,
                            ));
                            ()
                        }
                        _ => (),
                    }
                    emit(context, event).await;
                    successful += 1;
                }
            }
            Err(error) => {
                let status = error_status(&error);
                let details =
                    json!({"recordType":record_type,"resolver":"system","resolverStatus":status});
                let item = evidence(
                    "dns",
                    "recordQuery",
                    &target,
                    status,
                    None,
                    Some(record_type.clone()),
                    None,
                    details,
                    vec!["Resolver status applies only to this query and time.".to_owned()],
                );
                let mut event = ReconEvent::new(&context.job_id, 0, "dns", "finding");
                event.provider = Some("dns".to_owned());
                event.evidence.push(item);
                emit(context, event).await;
                if !matches!(status, "nxdomain" | "nodata") {
                    failures += 1;
                } else {
                    successful += 1;
                }
            }
        }
    }

    let status = if successful == 0 {
        "error"
    } else if failures > 0 {
        "partial"
    } else {
        "complete"
    };
    provider_state(
        context,
        "dns",
        status,
        if failures > 0 {
            Some(format!(
                "{failures} DNS record queries failed; successful answers were kept."
            ))
        } else {
            None
        },
    )
    .await;
    DnsSummary {
        public_ips: public_ips.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::{canonical_name, error_status};

    #[test]
    fn names_are_normalized_and_dns_negative_states_remain_distinct() {
        assert_eq!(canonical_name(" MX.Example.COM. "), "mx.example.com");
        assert_eq!(
            error_status("NoRecordsFound response_code NXDomain"),
            "nxdomain"
        );
        assert_eq!(
            error_status("NoRecordsFound response_code NoError"),
            "nodata"
        );
        assert_eq!(error_status("SERVFAIL"), "servfail");
        assert_eq!(error_status("query timeout"), "timeout");
    }
}
