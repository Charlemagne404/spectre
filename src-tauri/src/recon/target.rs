use idna::domain_to_ascii;
use serde::Serialize;
use url::Url;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTarget {
    pub input: String,
    pub hostname: String,
    pub registrable_domain: String,
}

pub fn normalize_target(input: &str) -> Result<NormalizedTarget, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > 2048 {
        return Err("Enter a domain name up to 2,048 characters long.".to_owned());
    }

    let hostname = if input.contains("://") {
        let authority = input
            .split_once("://")
            .map(|(_, remainder)| remainder.split(['/', '?', '#']).next().unwrap_or(""))
            .unwrap_or("");
        if authority.contains(':') {
            return Err("Only a bare domain or HTTP(S) origin is accepted; paths, credentials, ports, and query strings are out of scope.".to_owned());
        }
        let url = Url::parse(input)
            .map_err(|_| "Enter a valid domain name or HTTP(S) URL.".to_owned())?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
        {
            return Err("Only a bare domain or HTTP(S) origin is accepted; paths, credentials, ports, and query strings are out of scope.".to_owned());
        }
        url.host_str()
            .ok_or_else(|| "The URL must contain a domain name.".to_owned())?
            .to_owned()
    } else {
        if input.contains('/')
            || input.contains('\\')
            || input.contains('@')
            || input.contains('?')
            || input.contains('#')
            || input.contains(':')
            || input.chars().any(char::is_whitespace)
        {
            return Err(
                "Enter a domain name without a path, port, credentials, or query.".to_owned(),
            );
        }
        input.to_owned()
    };

    let hostname = hostname.trim_end_matches('.');
    if hostname.is_empty() || hostname.len() > 1024 {
        return Err("The domain name is empty or too long.".to_owned());
    }
    if hostname.parse::<std::net::IpAddr>().is_ok() {
        return Err(
            "Enter a domain name; IP address targets are outside this RECON workflow.".to_owned(),
        );
    }
    let ascii = domain_to_ascii(hostname)
        .map_err(|_| "The domain name contains invalid IDNA characters.".to_owned())?
        .to_ascii_lowercase();
    if ascii.len() > 253
        || ascii.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err(
            "The domain name has an invalid label or exceeds DNS length limits.".to_owned(),
        );
    }

    let suffix = psl::suffix_str(&ascii).ok_or_else(|| {
        "The name does not end in a recognized public suffix; enter a registrable public domain.".to_owned()
    })?;
    if ascii == suffix {
        return Err("Enter a domain below the public suffix, such as example.com.".to_owned());
    }
    let registrable_domain = psl::domain_str(&ascii)
        .ok_or_else(|| "The domain has no registrable public-domain boundary.".to_owned())?
        .to_owned();

    Ok(NormalizedTarget {
        input: input.to_owned(),
        hostname: ascii,
        registrable_domain,
    })
}

#[cfg(test)]
mod tests {
    use super::normalize_target;

    #[test]
    fn normalizes_case_trailing_dot_urls_and_idna_without_widening_scope() {
        let target = normalize_target("HTTPS://BÜCHER.Example.COM./").unwrap();
        assert_eq!(target.hostname, "xn--bcher-kva.example.com");
        assert_eq!(target.registrable_domain, "example.com");

        let subdomain = normalize_target("mail.shop.example.co.uk").unwrap();
        assert_eq!(subdomain.hostname, "mail.shop.example.co.uk");
        assert_eq!(subdomain.registrable_domain, "example.co.uk");
    }

    #[test]
    fn rejects_non_domains_and_ambiguous_scope() {
        for invalid in [
            "",
            "localhost",
            "127.0.0.1",
            "https://example.com/admin",
            "https://user@example.com",
            "example.com:443",
            "https://example.com:443",
            "com",
            "bad..example.com",
        ] {
            assert!(
                normalize_target(invalid).is_err(),
                "should reject {invalid}"
            );
        }
    }
}
