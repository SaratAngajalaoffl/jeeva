fn startup_message() -> String {
    "jeeva engine starting".to_string()
}

fn main() {
    println!("{}", startup_message());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_message_is_non_empty() {
        assert!(!startup_message().is_empty());
    }
}
