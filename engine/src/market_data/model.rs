/// One observation of a PERP's market conditions at a point in time.
#[derive(Debug, Clone, PartialEq)]
pub struct MarketDataSample {
    pub symbol: String,
    pub price: f64,
    pub open_interest: f64,
    pub volume: f64,
    pub spread: f64,
    pub mid_price: f64,
}
