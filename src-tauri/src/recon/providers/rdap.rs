use serde_json::{json, Value};
use url::Url;

use crate::recon::model::{evidence, ReconEntity, ReconEvent, ReconRelationship};
use crate::recon::providers::common::{
    emit, get_json, phase, provider_error, provider_state, ProviderContext,
};

const IANA_DNS_BOOTSTRAP: &str = "https://data.iana.org/rdap/dns.json";

pub fn select_service(bootstrap: &Value, hostname: &str) -> Option<String> {
    let services = bootstrap.get("services")?.as_array()?;
    let mut candidates = Vec::new();
    for service in services {
        let Some(pair) = service.as_array() else {
            continue;
        };
        if pair.len() != 2 {
            continue;
        }
        let Some(suffixes) = pair[0].as_array() else {
            continue;
        };
        let Some(urls) = pair[1].as_array() else {
            continue;
        };
        for suffix in suffixes.iter().filter_map(Value::as_str) {
            let suffix = suffix.trim_matches('.').to_ascii_lowercase();
            if hostname == suffix || hostname.ends_with(&format!(".{suffix}")) {
                for endpoint in urls.iter().filter_map(Value::as_str) {
                    candidates.push((suffix.len(), endpoint.to_owned()));
                }
            }
        }
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    candidates.into_iter().map(|(_, endpoint)| endpoint).next()
}

fn safe_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|text| text.chars().take(240).collect())
}

fn event_date(event: &Value, action: &str) -> Option<String> {
    let current = event.get("eventAction")?.as_str()?;
    if !current.eq_ignore_ascii_case(action) {
        return None;
    }
    safe_text(event.get("eventDate"))
}

fn registrar_name(entity: &Value) -> Option<String> {
    if !entity.get("roles")?.as_array()?.iter().any(|role| {
        role.as_str()
            .is_some_and(|role| role.eq_ignore_ascii_case("registrar"))
    }) {
        return None;
    }
    let card = entity.get("vcardArray")?.as_array()?.get(1)?.as_array()?;
    card.iter().find_map(|property| {
        let values = property.as_array()?;
        if values.first()?.as_str()? != "fn" {
            return None;
        }
        values
            .get(3)
            .and_then(Value::as_str)
            .map(|value| value.chars().take(120).collect())
    })
}

pub fn summarize_response(response: &Value) -> (Value, Option<String>) {
    let statuses = response
        .get("status")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .take(20)
                .map(|value| value.chars().take(100).collect::<String>())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let nameservers = response
        .get("nameservers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| safe_text(item.get("ldhName")))
                .take(100)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let events = response
        .get("events")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(30)
                .filter_map(|item| {
                    let action = safe_text(item.get("eventAction"))?;
                    let date = safe_text(item.get("eventDate"))?;
                    Some(json!({"action":action,"date":date}))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let registrar = response
        .get("entities")
        .and_then(Value::as_array)
        .and_then(|items| items.iter().find_map(registrar_name));
    let redacted = response
        .get("redacted")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .take(40)
                .map(|name| name.chars().take(100).collect::<String>())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let summary = json!({
        "objectClassName":safe_text(response.get("objectClassName")),
        "ldhName":safe_text(response.get("ldhName")),
        "handle":safe_text(response.get("handle")),
        "status":statuses,
        "nameservers":nameservers,
        "events":events,
        "registrar":registrar,
        "redactedFields":redacted,
    });
    (summary, registrar)
}

pub async fn collect(context: &ProviderContext) {
    provider_state(context, "rdap", "running", None).await;
    phase(context, "rdap", "querying").await;
    let bootstrap_url = match Url::parse(IANA_DNS_BOOTSTRAP) {
        Ok(url) => url,
        Err(error) => {
            provider_state(
                context,
                "rdap",
                "error",
                Some(format!("Invalid IANA bootstrap URL: {error}")),
            )
            .await;
            return;
        }
    };
    let bootstrap = match get_json(context, bootstrap_url).await {
        Ok(value) => value,
        Err(error) => {
            if error != "Cancelled" {
                provider_error(context, "rdap", error).await;
            }
            return;
        }
    };
    let Some(service) = select_service(&bootstrap, &context.target.hostname) else {
        provider_state(
            context,
            "rdap",
            "unavailable",
            Some("IANA RDAP bootstrap has no matching service for this public suffix.".to_owned()),
        )
        .await;
        return;
    };
    let Ok(mut base) = Url::parse(&service) else {
        provider_state(
            context,
            "rdap",
            "error",
            Some("IANA bootstrap contained a malformed service URL.".to_owned()),
        )
        .await;
        return;
    };
    if base.scheme() != "https"
        || base.username() != ""
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
        || base.port().is_some_and(|port| port != 443)
    {
        provider_state(
            context,
            "rdap",
            "error",
            Some("IANA RDAP service is not a plain HTTPS endpoint.".to_owned()),
        )
        .await;
        return;
    }
    if !base.path().ends_with('/') {
        base.set_path(&format!("{}/", base.path()));
    }
    let path = format!("domain/{}", context.target.registrable_domain);
    let Ok(endpoint) = base.join(&path) else {
        provider_state(
            context,
            "rdap",
            "error",
            Some("Could not construct the RDAP domain query.".to_owned()),
        )
        .await;
        return;
    };
    let response = match get_json(context, endpoint.clone()).await {
        Ok(value) => value,
        Err(error) => {
            if error != "Cancelled" {
                provider_error(context, "rdap", error).await;
            }
            return;
        }
    };
    let (summary, registrar) = summarize_response(&response);
    let lookup_name = context.target.registrable_domain.clone();
    let source = endpoint.to_string();
    let mut item = evidence(
        "rdap", "domainRegistration", &lookup_name, "observed", Some(source), None, Some(lookup_name.clone()),
        summary.clone(), vec!["RDAP registration is queried for the registrable domain; DNS scope remains the exact entered hostname.".to_owned(), "Public contact fields are omitted to avoid retaining personal registration data.".to_owned()],
    );
    item.observed_at = summary
        .get("events")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find_map(|event| event_date(event, "registration"))
        });
    let evidence_id = item.id.clone();
    let mut event = ReconEvent::new(&context.job_id, 0, "rdap", "finding");
    event.provider = Some("rdap".to_owned());
    event.evidence.push(item);
    if let Some(registrar) = registrar {
        let entity_id = format!("registrar:{}", registrar.to_ascii_lowercase());
        event.entities.push(ReconEntity {
            id: entity_id.clone(),
            kind: "registrar".to_owned(),
            label: registrar,
            attributes: json!({"source":"RDAP"}),
        });
        event.relationships.push(ReconRelationship {
            id: format!("rel:rdap:{}", entity_id),
            from: format!("domain:{}", context.target.hostname),
            to: entity_id,
            kind: "registeredWith".to_owned(),
            label: "registrar of".to_owned(),
            evidence_ids: vec![evidence_id],
        });
    }
    emit(context, event).await;
    provider_state(context, "rdap", "complete", None).await;
}

#[cfg(test)]
mod tests {
    use super::{select_service, summarize_response};
    use serde_json::json;

    #[test]
    fn bootstrap_uses_the_longest_matching_suffix() {
        let bootstrap = json!({"services":[
            [["uk"],["https://rdap.example/uk/"]],
            [["co.uk"],["https://registry.example/uk/"]],
            [["com"],["https://com.example/rdap/"]]
        ]});
        assert_eq!(
            select_service(&bootstrap, "shop.example.co.uk").as_deref(),
            Some("https://registry.example/uk/")
        );
        assert_eq!(
            select_service(&bootstrap, "example.com").as_deref(),
            Some("https://com.example/rdap/")
        );
        assert_eq!(
            select_service(&bootstrap, "notexample.com.evil").as_deref(),
            None
        );
    }

    #[test]
    fn response_summary_keeps_public_registration_fields_and_omits_contact_details() {
        let response = json!({
            "objectClassName":"domain","ldhName":"example.com","status":["active"],
            "nameservers":[{"ldhName":"ns1.example.net"}],
            "events":[{"eventAction":"registration","eventDate":"2000-01-01T00:00:00Z"}],
            "entities":[{"roles":["registrar"],"vcardArray":["vcard",[["fn",{},"text","Example Registrar"],["email",{},"text","person@example.com"]]]}],
            "redacted":[{"name":"Registrant Name"}]
        });
        let (summary, registrar) = summarize_response(&response);
        assert_eq!(registrar.as_deref(), Some("Example Registrar"));
        assert_eq!(summary["events"][0]["date"], "2000-01-01T00:00:00Z");
        assert_eq!(summary["nameservers"][0], "ns1.example.net");
        assert!(summary.to_string().contains("redacted"));
        assert!(!summary.to_string().contains("person@example.com"));
    }
}
