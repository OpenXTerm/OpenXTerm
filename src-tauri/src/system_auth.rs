use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAuthSupport {
    pub available: bool,
    pub method_label: String,
    pub detail: String,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn openxterm_can_evaluate_biometrics() -> bool;
    fn openxterm_can_evaluate_device_authentication() -> bool;
    fn openxterm_request_system_auth(
        reason_ptr: *const u8,
        reason_len: usize,
        prefer_biometrics: bool,
    ) -> bool;
}

pub fn get_system_auth_support() -> Result<SystemAuthSupport, String> {
    #[cfg(target_os = "macos")]
    {
        let biometrics_available = unsafe { openxterm_can_evaluate_biometrics() };
        let device_auth_available = unsafe { openxterm_can_evaluate_device_authentication() };

        return Ok(if biometrics_available {
            SystemAuthSupport {
                available: true,
                method_label: "Touch ID".into(),
                detail: "Touch ID is available for unlocking OpenXTerm.".into(),
            }
        } else if device_auth_available {
            SystemAuthSupport {
                available: true,
                method_label: "macOS authentication".into(),
                detail: "System authentication is available for unlocking OpenXTerm.".into(),
            }
        } else {
            SystemAuthSupport {
                available: false,
                method_label: "Touch ID".into(),
                detail: "Touch ID is not available or not configured on this Mac.".into(),
            }
        });
    }

    #[cfg(target_os = "windows")]
    {
        use windows::{
            core::HSTRING,
            Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability},
        };

        let availability = UserConsentVerifier::CheckAvailabilityAsync()
            .map_err(|error| format!("failed to query Windows Hello availability: {error}"))?
            .get()
            .map_err(|error| format!("failed to resolve Windows Hello availability: {error}"))?;

        let support = match availability {
            UserConsentVerifierAvailability::Available => SystemAuthSupport {
                available: true,
                method_label: "Windows Hello / PIN".into(),
                detail: "Windows Hello is available for unlocking OpenXTerm.".into(),
            },
            UserConsentVerifierAvailability::DeviceBusy => SystemAuthSupport {
                available: false,
                method_label: "Windows Hello / PIN".into(),
                detail: "Windows Hello is busy right now.".into(),
            },
            UserConsentVerifierAvailability::DeviceNotPresent => SystemAuthSupport {
                available: false,
                method_label: "Windows Hello / PIN".into(),
                detail: "Windows Hello is not available on this device.".into(),
            },
            UserConsentVerifierAvailability::DisabledByPolicy => SystemAuthSupport {
                available: false,
                method_label: "Windows Hello / PIN".into(),
                detail: "Windows Hello is disabled by policy.".into(),
            },
            UserConsentVerifierAvailability::NotConfiguredForUser => SystemAuthSupport {
                available: false,
                method_label: "Windows Hello / PIN".into(),
                detail: "Windows Hello or PIN is not configured for this user.".into(),
            },
            _ => SystemAuthSupport {
                available: false,
                method_label: "Windows Hello / PIN".into(),
                detail: "Windows Hello is unavailable.".into(),
            },
        };

        let _ = HSTRING::new();
        return Ok(support);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(SystemAuthSupport {
            available: false,
            method_label: "System authentication".into(),
            detail: "System unlock is implemented only for macOS and Windows.".into(),
        })
    }
}

pub fn request_system_unlock(reason: Option<String>) -> Result<bool, String> {
    let reason = reason.unwrap_or_else(|| "Unlock OpenXTerm".into());

    #[cfg(target_os = "macos")]
    {
        let prefer_biometrics = unsafe { openxterm_can_evaluate_biometrics() };
        let granted = unsafe {
            openxterm_request_system_auth(
                reason.as_bytes().as_ptr(),
                reason.len(),
                prefer_biometrics,
            )
        };
        return Ok(granted);
    }

    #[cfg(target_os = "windows")]
    {
        use windows::{
            core::HSTRING,
            Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier},
        };

        let result = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason))
            .map_err(|error| format!("failed to start Windows Hello verification: {error}"))?
            .get()
            .map_err(|error| format!("failed to resolve Windows Hello verification: {error}"))?;

        return match result {
            UserConsentVerificationResult::Verified => Ok(true),
            UserConsentVerificationResult::Canceled
            | UserConsentVerificationResult::Timeout
            | UserConsentVerificationResult::RetriesExhausted
            | UserConsentVerificationResult::DeviceBusy => Ok(false),
            UserConsentVerificationResult::DeviceNotPresent => {
                Err("Windows Hello device is not present.".into())
            }
            UserConsentVerificationResult::DisabledByPolicy => {
                Err("Windows Hello is disabled by policy.".into())
            }
            UserConsentVerificationResult::NotConfiguredForUser => {
                Err("Windows Hello or PIN is not configured for this user.".into())
            }
            _ => Ok(false),
        };
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = reason;
        Ok(false)
    }
}
