//! Shared Hyperliquid market/DEX naming rules.
//!
//! Jeeva stores a PERP's exchange identity as one opaque symbol. Default
//! DEX markets use the legacy unnamespaced coin (`BTC`), while HIP-3
//! markets retain the exchange's `<dex>:<coin>` namespace (`xyz:AAOI`).
//! Endpoints which address a whole universe need the namespace split into
//! their separate `dex` parameter; endpoints which address one coin accept
//! the namespaced symbol as-is.

pub fn dex(symbol: &str) -> Option<&str> {
    symbol.split_once(':').map(|(dex, _coin)| dex)
}

pub fn coin(symbol: &str) -> &str {
    symbol.split_once(':').map_or(symbol, |(_dex, coin)| coin)
}

#[cfg(test)]
mod tests {
    use super::{coin, dex};

    #[test]
    fn default_symbols_remain_unnamespaced() {
        assert_eq!(dex("BTC"), None);
        assert_eq!(coin("BTC"), "BTC");
    }

    #[test]
    fn hip3_symbols_split_into_dex_and_coin() {
        assert_eq!(dex("xyz:AAOI"), Some("xyz"));
        assert_eq!(coin("xyz:AAOI"), "AAOI");
    }
}
