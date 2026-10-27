//! Shared DNS/IP policy; callers own consent, endpoint restrictions and HTTP limits.
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::net::lookup_host;
use url::Url;

#[derive(Debug)]
pub(crate) struct NetworkError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}
impl NetworkError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AddressKind {
    Loopback,
    Private,
    Public,
    Blocked,
}

pub(crate) fn classify_ip(ip: IpAddr) -> AddressKind {
    match ip {
        IpAddr::V4(ip) => {
            if ip.is_unspecified()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip == Ipv4Addr::BROADCAST
            {
                AddressKind::Blocked
            } else if ip.is_loopback() {
                AddressKind::Loopback
            } else if ip.is_private() {
                AddressKind::Private
            } else {
                AddressKind::Public
            }
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return classify_ip(IpAddr::V4(v4));
            }
            if ip.is_unspecified() || ip.is_multicast() || ip.is_unicast_link_local() {
                AddressKind::Blocked
            } else if ip.is_loopback() {
                AddressKind::Loopback
            } else if (ip.segments()[0] & 0xfe00) == 0xfc00 {
                AddressKind::Private
            } else {
                AddressKind::Public
            }
        }
    }
}

pub(crate) async fn resolve_target(url: &Url) -> Result<Vec<SocketAddr>, NetworkError> {
    let host = url
        .host_str()
        .ok_or_else(|| NetworkError::new("INVALID_URL", "API 地址缺少主机名"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| NetworkError::new("INVALID_URL", "API 地址缺少端口"))?;
    let addresses: Vec<_> = lookup_host((host.trim_matches(['[', ']']), port))
        .await
        .map_err(|error| NetworkError::new("DNS_RESOLUTION_FAILED", error.to_string()))?
        .collect();
    if addresses.is_empty() {
        return Err(NetworkError::new(
            "DNS_RESOLUTION_FAILED",
            "API 地址未解析到可用 IP",
        ));
    }
    let kinds: Vec<_> = addresses
        .iter()
        .map(|address| classify_ip(address.ip()))
        .collect();
    validate_address_kinds(url.scheme(), &kinds)?;
    Ok(addresses)
}

pub(crate) fn validate_address_kinds(
    scheme: &str,
    kinds: &[AddressKind],
) -> Result<(), NetworkError> {
    if kinds.contains(&AddressKind::Blocked) {
        return Err(NetworkError::new(
            "ADDRESS_NOT_ALLOWED",
            "目标地址属于永久禁止访问的网络范围",
        ));
    }
    if scheme == "http" && kinds.contains(&AddressKind::Public) {
        return Err(NetworkError::new(
            "PUBLIC_HTTP_NOT_ALLOWED",
            "公网 API 仅允许使用 HTTPS",
        ));
    }
    Ok(())
}
