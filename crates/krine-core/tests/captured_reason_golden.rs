//! The expected bytes were produced by the server capture implementation at
//! ebd7173fb41cb96098745fe3cda9cc884f34674c, before moving it into krine-core.
//! Keep these as recorded expectations, rather than regenerating from new code.
use krine_core::capture_reason;
use serde_json::Value;

#[test]
fn captured_reason_matches_original_server_bytes_and_errors() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/reason-summaries.json")).unwrap();
    for (index, case) in cases.iter().enumerate() {
        let label = case["name"]
            .as_str()
            .unwrap_or("evaluation or invalid record");
        let result = capture_reason(&case["detail"]);
        if case["error"] == true {
            assert!(result.is_err(), "case {index}: {label}");
        } else {
            assert_eq!(
                serde_json::to_string(&result.unwrap()).unwrap(),
                case["expected_bytes"].as_str().unwrap(),
                "case {index}: {label}"
            );
        }
    }
}
