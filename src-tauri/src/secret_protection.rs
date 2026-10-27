#[cfg(target_os = "windows")]
pub(crate) fn protect_secret(value: &str) -> Result<Vec<u8>, String> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let bytes = value.as_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok = unsafe { CryptProtectData(&input, null(), null(), null(), null(), 0, &mut output) };
    if ok == 0 {
        return Err("failed to encrypt secret with Windows DPAPI".into());
    }

    let encrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(encrypted)
}

#[cfg(target_os = "windows")]
pub(crate) fn unprotect_secret(value: &[u8]) -> Result<String, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok =
        unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut output) };
    if ok == 0 {
        return Err("failed to decrypt secret with Windows DPAPI".into());
    }

    let decrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    String::from_utf8(decrypted).map_err(|err| err.to_string())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn protect_secret(value: &str) -> Result<Vec<u8>, String> {
    let _ = value;
    Err("当前平台不支持系统安全存储".into())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn unprotect_secret(value: &[u8]) -> Result<String, String> {
    let _ = value;
    Err("当前平台不支持系统安全存储".into())
}
