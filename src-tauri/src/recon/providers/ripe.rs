use std::collections::BTreeSet;
use std::net::IpAddr;

use serde_json::{json, Value};
use tokio::task::JoinSet;
use url::Url;

use crate::recon::model::{evidence, ReconEntity, ReconEvent, ReconRelationship};
use crate::recon::providers::common::{
    emit, get_json, is_public_ip, provider_error, provider_state, ProviderContext,
};

const MAX_IPS: usize = 8;

fn ripe_url(endpoint: &str, resource: &str) -> Url {
    let mut url = Url::parse(&format!("https://stat.ripe.net/data/{endpoint}/data.json"))
        .expect("fixed RIPEstat URL is valid");
    url.query_pairs_mut().append_pair("resource", resource);
    url
}

fn data(response: &Value) -> Option<&Value> {
    if response
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status != "ok")
    {
        return None;
    }
    response.get("data")
}

fn asn_values(data: &Value) -> Vec<String> {
    data.get("asns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            value
                .as_u64()
                .map(|number| format!("AS{number}"))
                .or_else(|| {
                    value.as_str().and_then(|text| {
                        let text = text.trim().trim_start_matches("AS");
                        text.parse::<u64>().ok().map(|number| format!("AS{number}"))
                    })
                })
        })
        .take(16)
        .collect()
}

fn safe_route_summary(response: &Value) -> Value {
    let Some(data) = data(response) else {
        return json!({"status":"unavailable"});
    };
    let seen = |key: &str| {
        data.get(key).map(|entry| json!({
            "time":entry.get("time").and_then(Value::as_str).map(|value| value.chars().take(64).collect::<String>()),
            "origin":entry.get("origin").and_then(Value::as_str).map(|value| value.chars().take(24).collect::<String>()),
            "prefix":entry.get("prefix").and_then(Value::as_str).map(|value| value.chars().take(80).collect::<String>()),
        })).unwrap_or(Value::Null)
    };
    let origins = data
        .get("origins")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(20)
                .filter_map(|item| {
                    item.get("origin").and_then(|origin| {
                        origin
                            .as_str()
                            .map(|value| value.chars().take(24).collect::<String>())
                            .or_else(|| origin.as_u64().map(|value| format!("AS{value}")))
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let visibility =
        data.get("visibility")
            .and_then(Value::as_object)
            .map(|families| {
                let mut summary = serde_json::Map::new();
                for family in ["v4", "v6"] {
                    if let Some(info) = families.get(family) {
                        summary.insert(family.to_owned(), json!({
                    "risPeersSeeing":info.get("ris_peers_seeing").and_then(Value::as_u64),
                    "totalRisPeers":info.get("total_ris_peers").and_then(Value::as_u64),
                }));
                    }
                }
                Value::Object(summary)
            })
            .unwrap_or(Value::Null);
    json!({
        "queryTime":data.get("query_time").and_then(Value::as_str).map(|value| value.chars().take(64).collect::<String>()),
        "origins":origins,
        "firstSeen":seen("first_seen"),
        "lastSeen":seen("last_seen"),
        "visibility":visibility,
        "status":"ok"
    })
}

fn valid_prefix(value: &str) -> bool {
    let Some((address, length)) = value.split_once('/') else {
        return false;
    };
    let Ok(address) = address.parse::<IpAddr>() else {
        return false;
    };
    let Ok(length) = length.parse::<u8>() else {
        return false;
    };
    length <= if address.is_ipv4() { 32 } else { 128 }
}

async fn enrich_one(
    context: ProviderContext,
    address: IpAddr,
) -> (IpAddr, Result<Value, String>, Result<Value, String>) {
    let address = address.to_string();
    let (network, routing) = tokio::join!(
        get_json(&context, ripe_url("network-info", &address)),
        get_json(&context, ripe_url("routing-status", &address)),
    );
    (
        address.parse().expect("address remains valid"),
        network,
        routing,
    )
}

pub async fn enrich(context: &ProviderContext, addresses: Vec<IpAddr>) {
    let mut unique = BTreeSet::new();
    for address in addresses
        .into_iter()
        .filter(|address| is_public_ip(*address))
        .take(64)
    {
        unique.insert(address);
    }
    let addresses = unique.into_iter().take(MAX_IPS).collect::<Vec<_>>();
    if addresses.is_empty() {
        provider_state(
            context,
            "ripestat",
            "unavailable",
            Some("No public IP addresses were observed for routing enrichment.".to_owned()),
        )
        .await;
        return;
    }
    provider_state(context, "ripestat", "running", None).await;
    let mut jobs = JoinSet::new();
    for address in addresses {
        let context = context.clone();
        jobs.spawn(async move { enrich_one(context, address).await });
    }

    let mut failures = 0usize;
    let mut successful = 0usize;
    let mut errors = Vec::new();
    while let Some(joined) = jobs.join_next().await {
        if context.cancel.is_cancelled() {
            break;
        }
        let Ok((address, network_result, routing_result)) = joined else {
            failures += 1;
            errors.push("RIPEstat request task failed.".to_owned());
            continue;
        };
        let ip_id = format!("ip:{address}");
        let mut event = ReconEvent::new(&context.job_id, 0, "ripestat", "finding");
        event.provider = Some("ripestat".to_owned());
        match network_result {
            Ok(network_response) => {
                if let Some(network_data) = data(&network_response) {
                    let prefix = network_data
                        .get("prefix")
                        .and_then(Value::as_str)
                        .filter(|value| valid_prefix(value))
                        .map(|value| value.chars().take(80).collect::<String>());
                    let asns = asn_values(network_data);
                    if let Some(prefix) = prefix {
                        let prefix_id = format!("prefix:{prefix}");
                        event.entities.push(ReconEntity {
                            id: prefix_id.clone(),
                            kind: "prefix".to_owned(),
                            label: prefix.clone(),
                            attributes: json!({"source":"RIPE RIS"}),
                        });
                        let ev = evidence("ripestat", "networkInfo", &address.to_string(), "observed", Some("https://stat.ripe.net/docs/data-api/api-endpoints/network-info".to_owned()), Some(address.to_string()), Some(prefix.clone()), json!({"prefix":prefix,"asns":asns}), vec!["RIPE RIS reports the containing announced prefix and origin ASNs; this is routing visibility, not proof of registrant or host ownership.".to_owned()]);
                        let ev_id = ev.id.clone();
                        event.evidence.push(ev);
                        event.relationships.push(ReconRelationship {
                            id: format!("rel:route:prefix:{address}:{prefix}"),
                            from: ip_id.clone(),
                            to: prefix_id,
                            kind: "withinPrefix".to_owned(),
                            label: "within announced prefix".to_owned(),
                            evidence_ids: vec![ev_id.clone()],
                        });
                        for asn in asns {
                            let label = asn.clone();
                            let asn_id = format!("asn:{asn}");
                            event.entities.push(ReconEntity {
                                id: asn_id.clone(),
                                kind: "asn".to_owned(),
                                label,
                                attributes: json!({"number":asn,"registry":"RIPEstat"}),
                            });
                            event.relationships.push(ReconRelationship {
                                id: format!("rel:route:asn:{address}:{asn}"),
                                from: ip_id.clone(),
                                to: asn_id,
                                kind: "announcedBy".to_owned(),
                                label: "announced by".to_owned(),
                                evidence_ids: vec![ev_id.clone()],
                            });
                        }
                    } else {
                        failures += 1;
                        errors.push(
                            "RIPEstat network-info returned no valid announced prefix.".to_owned(),
                        );
                    }
                } else {
                    failures += 1;
                    errors.push(
                        "RIPEstat network-info returned an unsuccessful provider status."
                            .to_owned(),
                    );
                }
            }
            Err(error) => {
                failures += 1;
                errors.push(error);
            }
        }

        match routing_result {
            Ok(routing_response) => {
                let summary = safe_route_summary(&routing_response);
                let source_status = if summary["status"] == "ok" {
                    "observed"
                } else {
                    "unavailable"
                };
                event.evidence.push(evidence(
                "ripestat", "routingStatus", &address.to_string(), source_status,
                Some("https://stat.ripe.net/docs/data-api/api-endpoints/routing-status".to_owned()), Some(address.to_string()), None,
                summary, vec!["Routing status reflects RIPE RIS collector visibility and its sampling time; it is not a complete global routing view.".to_owned()],
            ));
            }
            Err(error) => {
                failures += 1;
                errors.push(error);
            }
        }
        if !event.evidence.is_empty() {
            successful += 1;
            emit(context, event).await;
        }
    }
    if successful == 0 && !errors.is_empty() {
        provider_error(context, "ripestat", errors.remove(0)).await;
    } else if failures > 0 {
        provider_state(
            context,
            "ripestat",
            "partial",
            Some(
                "Some IP routing lookups failed; successful observations were retained.".to_owned(),
            ),
        )
        .await;
    } else {
        provider_state(context, "ripestat", "complete", None).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{asn_values, safe_route_summary};
    use serde_json::json;

    #[test]
    fn network_and_route_fields_are_normalized_without_ownership_claims() {
        assert!(super::valid_prefix("203.0.113.0/24"));
        assert!(!super::valid_prefix("203.0.113.0/55"));
        assert!(!super::valid_prefix("<img>/24"));
        assert_eq!(
            asn_values(&json!({"asns":[64500,"AS64501"]})),
            vec!["AS64500", "AS64501"]
        );
        let summary = safe_route_summary(
            &json!({"status":"ok","data":{"query_time":"2026-11-24T00:00:00Z","origins":[{"origin":"AS64500"}]}}),
        );
        assert_eq!(summary["origins"][0], "AS64500");
    }
}
