//! Validate transport encoding before Axum's form decoder can replace bytes.
use crate::error::{ApiError, Result};

pub(crate) fn validate_encoding(query: Option<&str>) -> Result<()> {
    let Some(query) = query else {
        return Ok(());
    };
    for component in query.split(['&', '=']) {
        let mut bytes = component.bytes();
        let mut decoded = Vec::with_capacity(component.len());
        while let Some(byte) = bytes.next() {
            decoded.push(match byte {
                b'%' => {
                    let digit = |v: Option<u8>| {
                        v.and_then(|v| (v as char).to_digit(16))
                            .ok_or_else(|| ApiError::invalid("Invalid query encoding."))
                    };
                    (digit(bytes.next())? * 16 + digit(bytes.next())?) as u8
                }
                b'+' => b' ',
                value => value,
            });
        }
        std::str::from_utf8(&decoded).map_err(|_| ApiError::invalid("Invalid query encoding."))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_percent_escapes_and_utf8_never_rewrite_query_names_or_values() {
        for invalid in [
            "id=%FF",
            "id=%E7%95",
            "id=%C0%AF",
            "id=%ED%A0%80",
            "id=%F4%90%80%80",
            "id=%",
            "id=%1",
            "id=%Q1",
            "id=%1G",
            "%FF=id",
            "%E7%95=id",
            "i%=value",
            "id=%E7&%95=x",
            "id=%E7=%95",
        ] {
            assert!(validate_encoding(Some(invalid)).is_err(), "{invalid}");
        }
        for valid in [
            "id=%EF%BF%BD",
            "id=%E7%95%8C",
            "id=%25FF",
            "id=%252e",
            "id=%5Cx41",
            "id=%20Alice%C2%A0%20",
            "id=a+b",
            "id=a%2Bb",
            "id=%00",
            "i%64=one&%69d=two",
            "id=a=b",
            "",
            "id=",
        ] {
            assert!(validate_encoding(Some(valid)).is_ok(), "{valid}");
        }
        assert!(validate_encoding(None).is_ok());
    }
}
