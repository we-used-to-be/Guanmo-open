use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, System};
use tauri::State;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetric {
    pub pid: u32,
    pub process_type: String,
    pub working_set_kb: u64,
    pub private_working_set_kb: u64,
    pub private_bytes_kb: u64,
    pub commit_size_kb: u64,
    pub cpu_percent: f32,
    pub thread_count: u32,
    pub handle_count: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSnapshot {
    pub timestamp: u64,
    pub app_working_set_kb: u64,
    pub app_private_working_set_kb: u64,
    pub app_private_bytes_kb: u64,
    pub webview_working_set_kb: u64,
    pub webview_private_working_set_kb: u64,
    pub webview_private_bytes_kb: u64,
    pub rust_working_set_kb: u64,
    pub rust_private_working_set_kb: u64,
    pub rust_private_bytes_kb: u64,
    pub webview_process_count: u32,
    pub renderer_process_count: u32,
    pub gpu_process_count: u32,
    pub utility_process_count: u32,
    /// Core-equivalent CPU: sum of per-process cpu_usage() across all app processes.
    /// Each process reports 0–100 per logical core; sum can exceed 100 on multi-core.
    pub cpu_percent: f32,
    /// Number of logical CPU cores (hyperthread count). Used by frontend to normalize.
    pub logical_cpu_count: u32,
    /// System-wide CPU usage percentage (0–100), normalized across all cores.
    pub system_cpu_percent: f32,
    pub process_breakdown: Vec<ProcessMetric>,
}

/// Cached static info for a process — only re-read when PID changes or cache is invalidated.
#[derive(Clone, Debug)]
struct CachedProcessInfo {
    process_type: String,
    creation_time_ms: u64,
}

pub struct PerfMonitorState {
    system: Mutex<System>,
    process_cache: Mutex<HashMap<u32, CachedProcessInfo>>,
}

impl Default for PerfMonitorState {
    fn default() -> Self {
        Self {
            system: Mutex::new(System::new_all()),
            process_cache: Mutex::new(HashMap::new()),
        }
    }
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn is_webview_process(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("msedgewebview2") || name.contains("microsoftedgewebview2")
}

fn is_descendant_of(system: &System, pid: Pid, ancestor: Pid) -> bool {
    let mut current = system.process(pid).and_then(|process| process.parent());
    while let Some(parent) = current {
        if parent == ancestor {
            return true;
        }
        current = system.process(parent).and_then(|process| process.parent());
    }
    false
}

fn classify_webview_process(command: &[String]) -> String {
    if command.is_empty() {
        return "unknown".into();
    }
    let command = command.join(" ").to_ascii_lowercase();
    if command.contains("crashpad-handler") || command.contains("--type=crashpad") {
        return "crashpad".into();
    }
    if command.contains("--type=renderer") {
        return "renderer".into();
    }
    if command.contains("--type=gpu-process") {
        return "gpu-process".into();
    }
    if command.contains("network.mojom.networkservice")
        || command.contains("--type=network-service")
    {
        return "network-service".into();
    }
    if command.contains("--type=utility") {
        return "utility".into();
    }
    if !command.contains("--type=") {
        return "browser".into();
    }
    "unknown".into()
}

// ─── Windows command-line retrieval via NtQueryInformationProcess + ReadProcessMemory ───

#[cfg(windows)]
mod win32_cmdline {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    #[repr(C)]
    #[allow(dead_code)]
    struct ProcessBasicInformation {
        reserved1: *mut u8,
        peb_base_address: *mut u8,
        affinity_mask: usize,
        base_priority: i32,
        unique_process_id: *mut u8,
        inherited_from_unique_process_id: *mut u8,
    }

    #[repr(C)]
    #[allow(dead_code)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }

    // x64 offsets
    const PEB_PROCESS_PARAMETERS_OFFSET: usize = 0x20;
    const PROCESS_PARAMETERS_COMMANDLINE_OFFSET: usize = 0x70;

    extern "system" {
        fn NtQueryInformationProcess(
            process_handle: HANDLE,
            process_information_class: u32,
            process_information: *mut u8,
            process_information_length: u32,
            return_length: *mut u32,
        ) -> i32;
    }

    unsafe fn read_process_memory(
        handle: HANDLE,
        address: *const u8,
        buffer: *mut u8,
        size: usize,
    ) -> usize {
        extern "system" {
            fn ReadProcessMemory(
                h_process: HANDLE,
                lp_base_address: *const u8,
                lp_buffer: *mut u8,
                n_size: usize,
                lp_number_of_bytes_read: *mut usize,
            ) -> i32;
        }
        let mut bytes_read: usize = 0;
        ReadProcessMemory(handle, address, buffer, size, &mut bytes_read);
        bytes_read
    }

    /// Parse a Windows command line string into argv-style args, handling double-quote escaping.
    fn parse_windows_cmdline(raw: &str) -> Vec<String> {
        let mut args = Vec::new();
        let mut current = String::new();
        let mut in_quotes = false;
        let mut chars = raw.chars().peekable();
        for ch in chars.by_ref() {
            match ch {
                '"' => {
                    // Count consecutive backslashes before this quote
                    let mut backslashes = 0;
                    for c in current.chars().rev() {
                        if c == '\\' {
                            backslashes += 1;
                        } else {
                            break;
                        }
                    }
                    // 2N backslashes before quote → N literal backslashes, quote toggles
                    // 2N+1 backslashes before quote → N literal backslashes, literal quote
                    if backslashes % 2 == 0 {
                        in_quotes = !in_quotes;
                    } else {
                        // The last backslash was already pushed; just keep the quote literal
                    }
                }
                ' ' | '\t' if !in_quotes => {
                    if !current.is_empty() {
                        args.push(std::mem::take(&mut current));
                    }
                }
                _ => {
                    current.push(ch);
                }
            }
        }
        if !current.is_empty() {
            args.push(current);
        }
        args
    }

    pub fn read_process_command_line(pid: u32) -> Option<Vec<String>> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if handle.is_null() {
                return None;
            }

            // ProcessCommandLineInformation (class 60) avoids relying on remote PEB layout.
            let mut required_length = 0u32;
            NtQueryInformationProcess(handle, 60, std::ptr::null_mut(), 0, &mut required_length);
            if required_length >= std::mem::size_of::<UnicodeString>() as u32 {
                let mut query_buffer = vec![0u8; required_length as usize];
                let status = NtQueryInformationProcess(
                    handle,
                    60,
                    query_buffer.as_mut_ptr(),
                    required_length,
                    &mut required_length,
                );
                if status == 0 {
                    let command =
                        std::ptr::read_unaligned(query_buffer.as_ptr().cast::<UnicodeString>());
                    let buffer_start = query_buffer.as_ptr() as usize;
                    let buffer_end = buffer_start.saturating_add(query_buffer.len());
                    let command_start = command.buffer as usize;
                    let command_end = command_start.saturating_add(command.length as usize);
                    if command.length > 0
                        && command.length % 2 == 0
                        && command_start >= buffer_start
                        && command_end <= buffer_end
                    {
                        let utf16 =
                            std::slice::from_raw_parts(command.buffer, command.length as usize / 2);
                        let args = parse_windows_cmdline(&String::from_utf16_lossy(utf16));
                        CloseHandle(handle);
                        return (!args.is_empty()).then_some(args);
                    }
                }
            }

            // Get PEB address via NtQueryInformationProcess (class 0 = ProcessBasicInformation)
            let mut pbi: ProcessBasicInformation = std::mem::zeroed();
            let status = NtQueryInformationProcess(
                handle,
                0,
                &mut pbi as *mut _ as *mut u8,
                std::mem::size_of::<ProcessBasicInformation>() as u32,
                std::ptr::null_mut(),
            );
            if status != 0 || pbi.peb_base_address.is_null() {
                CloseHandle(handle);
                return None;
            }

            // Read ProcessParameters pointer from PEB
            let mut process_params_ptr: *mut u8 = std::ptr::null_mut();
            let bytes_read = read_process_memory(
                handle,
                pbi.peb_base_address.add(PEB_PROCESS_PARAMETERS_OFFSET),
                &mut process_params_ptr as *mut _ as *mut u8,
                std::mem::size_of::<*mut u8>(),
            );
            if bytes_read != std::mem::size_of::<*mut u8>() || process_params_ptr.is_null() {
                CloseHandle(handle);
                return None;
            }

            // Read CommandLine UNICODE_STRING from ProcessParameters
            let mut cmd_line: UnicodeString = std::mem::zeroed();
            let bytes_read = read_process_memory(
                handle,
                process_params_ptr.add(PROCESS_PARAMETERS_COMMANDLINE_OFFSET),
                &mut cmd_line as *mut _ as *mut u8,
                std::mem::size_of::<UnicodeString>(),
            );
            if bytes_read != std::mem::size_of::<UnicodeString>()
                || cmd_line.buffer.is_null()
                || cmd_line.length == 0
            {
                CloseHandle(handle);
                return None;
            }

            // Read command line buffer (UTF-16)
            let char_count = (cmd_line.length / 2) as usize;
            let mut buffer: Vec<u16> = vec![0u16; char_count];
            let bytes_read = read_process_memory(
                handle,
                cmd_line.buffer as *const u8,
                buffer.as_mut_ptr() as *mut u8,
                cmd_line.length as usize,
            );
            CloseHandle(handle);

            if bytes_read != cmd_line.length as usize {
                return None;
            }

            let raw = String::from_utf16_lossy(&buffer);
            let args = parse_windows_cmdline(&raw);
            if args.is_empty() {
                None
            } else {
                Some(args)
            }
        }
    }
}

#[cfg(not(windows))]
mod win32_cmdline {
    pub fn read_process_command_line(_pid: u32) -> Option<Vec<String>> {
        None
    }
}

#[cfg(windows)]
fn windows_thread_counts() -> HashMap<u32, u32> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };

    let mut counts = HashMap::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return counts;
        }
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        if Thread32First(snapshot, &mut entry) != 0 {
            loop {
                *counts.entry(entry.th32OwnerProcessID).or_insert(0) += 1;
                if Thread32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    counts
}

#[cfg(not(windows))]
fn windows_thread_counts() -> HashMap<u32, u32> {
    HashMap::new()
}

#[cfg(windows)]
fn windows_process_counters(pid: u32) -> (u64, u64, u64, u32) {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
        PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessHandleCount, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    unsafe {
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if process.is_null() {
            return (0, 0, 0, 0);
        }

        let mut handle_count = 0;
        GetProcessHandleCount(process, &mut handle_count);

        let mut ex2: PROCESS_MEMORY_COUNTERS_EX2 = zeroed();
        ex2.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
        let ex2_ok = K32GetProcessMemoryInfo(
            process,
            (&mut ex2 as *mut PROCESS_MEMORY_COUNTERS_EX2).cast::<PROCESS_MEMORY_COUNTERS>(),
            ex2.cb,
        ) != 0;
        if ex2_ok {
            CloseHandle(process);
            return (
                ex2.PrivateWorkingSetSize as u64 / 1024,
                ex2.PrivateUsage as u64 / 1024,
                ex2.PagefileUsage as u64 / 1024,
                handle_count,
            );
        }

        let mut ex: PROCESS_MEMORY_COUNTERS_EX = zeroed();
        ex.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ex_ok = K32GetProcessMemoryInfo(
            process,
            (&mut ex as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            ex.cb,
        ) != 0;
        CloseHandle(process);
        if ex_ok {
            (
                0,
                ex.PrivateUsage as u64 / 1024,
                ex.PagefileUsage as u64 / 1024,
                handle_count,
            )
        } else {
            (0, 0, 0, handle_count)
        }
    }
}

#[cfg(not(windows))]
fn windows_process_counters(_pid: u32) -> (u64, u64, u64, u32) {
    (0, 0, 0, 0)
}

fn collect_snapshot(
    system: &mut System,
    cache: &mut HashMap<u32, CachedProcessInfo>,
) -> PerfSnapshot {
    system.refresh_processes();
    system.refresh_cpu();
    let current_pid = sysinfo::get_current_pid().unwrap_or(Pid::from_u32(0));
    let thread_counts = windows_thread_counts();
    let mut process_breakdown = Vec::new();

    // Collect current PIDs for cache eviction
    let mut seen_pids = std::collections::HashSet::new();

    for (pid, process) in system.processes() {
        let is_rust = *pid == current_pid;
        let is_webview = !is_rust
            && is_webview_process(process.name())
            && is_descendant_of(system, *pid, current_pid);
        if !is_rust && !is_webview {
            continue;
        }

        let pid_u32 = pid.as_u32();
        seen_pids.insert(pid_u32);

        // ── Static info: use cache if available, otherwise read and cache ──
        let creation_time_ms = process.start_time().saturating_mul(1000);
        let cached = cache
            .get(&pid_u32)
            .filter(|cached| cached.creation_time_ms == creation_time_ms);
        let process_type = if is_rust {
            "rust-main".into()
        } else if let Some(c) = cached {
            c.process_type.clone()
        } else {
            // First time seeing this PID — read command line and classify
            // An unavailable command line is not evidence that this is the browser process.
            let cmd = win32_cmdline::read_process_command_line(pid_u32).unwrap_or_default();

            let ptype = classify_webview_process(&cmd);
            cache.insert(
                pid_u32,
                CachedProcessInfo {
                    process_type: ptype.clone(),
                    creation_time_ms,
                },
            );
            ptype
        };

        // ── Dynamic info: always query fresh ──
        let (private_working_set_kb, private_bytes_kb, commit_size_kb, handle_count) =
            windows_process_counters(pid_u32);

        process_breakdown.push(ProcessMetric {
            pid: pid_u32,
            process_type,
            working_set_kb: process.memory() / 1024,
            private_working_set_kb,
            private_bytes_kb,
            commit_size_kb,
            cpu_percent: process.cpu_usage(),
            thread_count: thread_counts.get(&pid_u32).copied().unwrap_or(0),
            handle_count,
        });
    }

    // Evict stale PIDs from cache
    cache.retain(|pid, _| seen_pids.contains(pid));

    process_breakdown.sort_by_key(|process| (process.process_type != "rust-main", process.pid));
    let rust = process_breakdown
        .iter()
        .find(|process| process.process_type == "rust-main");
    let webviews: Vec<_> = process_breakdown
        .iter()
        .filter(|process| process.process_type != "rust-main")
        .collect();
    let sum =
        |field: fn(&ProcessMetric) -> u64| webviews.iter().map(|process| field(process)).sum();
    let webview_working_set_kb = sum(|process| process.working_set_kb);
    let webview_private_working_set_kb = sum(|process| process.private_working_set_kb);
    let webview_private_bytes_kb = sum(|process| process.private_bytes_kb);
    let rust_working_set_kb = rust.map_or(0, |process| process.working_set_kb);
    let rust_private_working_set_kb = rust.map_or(0, |process| process.private_working_set_kb);
    let rust_private_bytes_kb = rust.map_or(0, |process| process.private_bytes_kb);

    PerfSnapshot {
        timestamp: current_timestamp_ms(),
        app_working_set_kb: rust_working_set_kb + webview_working_set_kb,
        app_private_working_set_kb: rust_private_working_set_kb + webview_private_working_set_kb,
        app_private_bytes_kb: rust_private_bytes_kb + webview_private_bytes_kb,
        webview_working_set_kb,
        webview_private_working_set_kb,
        webview_private_bytes_kb,
        rust_working_set_kb,
        rust_private_working_set_kb,
        rust_private_bytes_kb,
        webview_process_count: webviews.len() as u32,
        renderer_process_count: webviews
            .iter()
            .filter(|p| p.process_type == "renderer")
            .count() as u32,
        gpu_process_count: webviews
            .iter()
            .filter(|p| p.process_type == "gpu-process")
            .count() as u32,
        utility_process_count: webviews
            .iter()
            .filter(|p| p.process_type == "utility" || p.process_type == "network-service")
            .count() as u32,
        cpu_percent: process_breakdown
            .iter()
            .map(|process| process.cpu_percent)
            .sum(),
        logical_cpu_count: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1),
        system_cpu_percent: system.global_cpu_info().cpu_usage(),
        process_breakdown,
    }
}

#[tauri::command]
pub fn get_perf_snapshot(state: State<'_, PerfMonitorState>) -> Result<PerfSnapshot, String> {
    let mut system = state.system.lock().map_err(|error| error.to_string())?;
    let mut cache = state
        .process_cache
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(collect_snapshot(&mut system, &mut cache))
}

#[cfg(test)]
mod tests {
    use super::classify_webview_process;

    fn command(value: &str) -> Vec<String> {
        vec![value.to_owned()]
    }

    #[test]
    fn classifies_webview_process_types_without_browser_fallback() {
        assert_eq!(
            classify_webview_process(&command("msedgewebview2.exe")),
            "browser"
        );
        assert_eq!(
            classify_webview_process(&command("--type=renderer")),
            "renderer"
        );
        assert_eq!(
            classify_webview_process(&command("--type=gpu-process")),
            "gpu-process"
        );
        assert_eq!(
            classify_webview_process(&command("--type=utility")),
            "utility"
        );
        assert_eq!(
            classify_webview_process(&command("--type=other")),
            "unknown"
        );
        assert_eq!(classify_webview_process(&[]), "unknown");
    }
}
