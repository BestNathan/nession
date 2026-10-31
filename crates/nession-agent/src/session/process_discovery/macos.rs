//! macOS process observation through libproc and `sysctl`.
//!
//! There is no per-Pane cgroup here, so every Pane is observed through the
//! process table and PID/PPID recursion. The environment is never read:
//! `KERN_PROCARGS2` carries it after `argv`, and this parser stops at `argc`.

use std::collections::HashMap;
use std::ffi::CStr;
use std::sync::Mutex;

use super::{ProcessDetails, ProcessFacts, Sample};

/// `libproc.h`'s `PROC_ALL_PIDS`.
const PROC_ALL_PIDS: u32 = 1;
/// Bound on a process path buffer (`PROC_PIDPATHINFO_MAXSIZE`).
const PATH_MAX: usize = 4096;
/// Bound on a command-line buffer. A single argv string cannot exceed
/// `ARG_MAX` (~1 MiB on macOS); this is a defensive read bound.
const MAX_COMMAND_BUFFER: usize = 1024 * 1024;

/// `devname` returns a pointer into a shared static buffer.
static DEVNAME: Mutex<()> = Mutex::new(());

pub(super) fn table() -> std::io::Result<HashMap<u32, ProcessFacts>> {
    let pids = all_pids()?;
    let mut out = HashMap::new();
    for pid in pids {
        let Some(bsd) = bsd_info(pid) else { continue };
        let task = task_info(pid);
        out.insert(
            pid,
            ProcessFacts {
                ppid: (bsd.pbi_ppid != 0).then_some(bsd.pbi_ppid),
                pgid: (bsd.pbi_pgid != 0).then_some(bsd.pbi_pgid),
                sid: session_id(pid),
                tty: tty_name(bsd.e_tdev),
                start_time_ms: Some(
                    i64::try_from(bsd.pbi_start_tvsec)
                        .unwrap_or(i64::MAX)
                        .saturating_mul(1000)
                        + i64::try_from(bsd.pbi_start_tvusec / 1000).unwrap_or(0),
                ),
                rss_bytes: task.as_ref().map(|task| task.pti_resident_size),
                threads: task
                    .as_ref()
                    .and_then(|task| u32::try_from(task.pti_threadnum).ok()),
            },
        );
    }
    Ok(out)
}

pub(super) fn details(pid: u32) -> ProcessDetails {
    // The counters themselves come from the two timed samples; this read only
    // distinguishes "denied" from "the platform has no counters".
    let io_denied = matches!(
        rusage(pid),
        Err(error) if error == std::io::ErrorKind::PermissionDenied
    );
    ProcessDetails {
        executable: executable_path(pid),
        argv: command_argv(pid),
        io_denied,
    }
}

pub(super) fn sample(pids: &[u32]) -> HashMap<u32, Sample> {
    pids.iter()
        .map(|pid| {
            let task = task_info(*pid);
            let io = rusage(*pid).ok();
            (
                *pid,
                Sample {
                    cpu_ns: task
                        .as_ref()
                        .map(|task| task.pti_total_user.saturating_add(task.pti_total_system)),
                    io_read_bytes: io.as_ref().map(|info| info.ri_diskio_bytesread),
                    io_write_bytes: io.as_ref().map(|info| info.ri_diskio_byteswritten),
                    alive: task.is_some(),
                },
            )
        })
        .collect()
}

fn all_pids() -> std::io::Result<Vec<u32>> {
    // SAFETY: the first call passes a null buffer and zero size, which asks
    // libproc for the required byte count.
    let needed = unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Err(std::io::Error::last_os_error());
    }
    let capacity = usize::try_from(needed).unwrap_or(0) / std::mem::size_of::<libc::pid_t>() + 32;
    let mut buffer: Vec<libc::pid_t> = vec![0; capacity];
    let byte_len = capacity * std::mem::size_of::<libc::pid_t>();
    let Ok(buffer_size) = libc::c_int::try_from(byte_len) else {
        return Err(std::io::Error::other("pid list exceeds the libproc buffer"));
    };
    // SAFETY: the buffer is valid for `capacity * size_of::<pid_t>()` bytes and
    // libproc writes at most that many.
    let written =
        unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, buffer.as_mut_ptr().cast(), buffer_size) };
    if written <= 0 {
        return Err(std::io::Error::last_os_error());
    }
    let count = usize::try_from(written).unwrap_or(0) / std::mem::size_of::<libc::pid_t>();
    Ok(buffer
        .into_iter()
        .take(count)
        .filter(|pid| *pid > 0)
        .map(i32::cast_unsigned)
        .collect())
}

/// `size_of::<T>()` as the `c_int` libproc expects.
fn struct_size<T>() -> libc::c_int {
    libc::c_int::try_from(std::mem::size_of::<T>()).unwrap_or(libc::c_int::MAX)
}

fn bsd_info(pid: u32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = struct_size::<libc::proc_bsdinfo>();
    // SAFETY: the flavor matches the struct and the size is that struct's.
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (read == size).then_some(info)
}

fn task_info(pid: u32) -> Option<libc::proc_taskinfo> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = struct_size::<libc::proc_taskinfo>();
    // SAFETY: as above, with the task flavor.
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTASKINFO,
            0,
            (&mut info as *mut libc::proc_taskinfo).cast(),
            size,
        )
    };
    (read == size).then_some(info)
}

fn session_id(pid: u32) -> Option<u32> {
    // SAFETY: getsid has no pointer arguments.
    let sid = unsafe { libc::getsid(pid as libc::pid_t) };
    (sid >= 0).then_some(sid.cast_unsigned())
}

fn tty_name(dev: u32) -> Option<String> {
    if dev == 0 {
        return None;
    }
    let _guard = DEVNAME.lock().ok()?;
    // SAFETY: devname returns a NUL-terminated pointer into a static buffer;
    // the guard keeps another caller from replacing it while it is read.
    let raw = unsafe { libc::devname(dev as libc::dev_t, libc::S_IFCHR) };
    if raw.is_null() {
        return None;
    }
    let name = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    (!name.is_empty()).then_some(name)
}

fn executable_path(pid: u32) -> Option<String> {
    let mut buffer = [0u8; PATH_MAX];
    let buffer_size = u32::try_from(PATH_MAX).unwrap_or(u32::MAX);
    // SAFETY: the buffer is PATH_MAX bytes, which is the documented maximum.
    let written =
        unsafe { libc::proc_pidpath(pid as libc::c_int, buffer.as_mut_ptr().cast(), buffer_size) };
    if written <= 0 {
        return None;
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(PATH_MAX);
    let path = buffer.get(..end)?;
    Some(String::from_utf8_lossy(path).into_owned())
}

fn rusage(pid: u32) -> Result<libc::rusage_info_v4, std::io::ErrorKind> {
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let mut pointer: libc::rusage_info_t = (&mut info as *mut libc::rusage_info_v4).cast();
    // SAFETY: the flavor names the struct the buffer actually is.
    let result =
        unsafe { libc::proc_pid_rusage(pid as libc::c_int, libc::RUSAGE_INFO_V4, &mut pointer) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().kind());
    }
    Ok(info)
}

/// Parse `KERN_PROCARGS2`: `argc`, executable path, then exactly `argc` argv.
///
/// The environment follows `argv` in the same buffer. This parser stops after
/// the declared argument count and never reads past it.
fn command_argv(pid: u32) -> Option<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let mib_len = u32::try_from(mib.len()).unwrap_or(u32::MAX);
    let mut size: libc::size_t = 0;
    // SAFETY: the MIB is valid for its length; a null old pointer asks for the
    // required size.
    let probe = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib_len,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if probe != 0 || !(4..=MAX_COMMAND_BUFFER).contains(&size) {
        return None;
    }

    let mut buffer = vec![0u8; size];
    // SAFETY: the buffer is `size` bytes, the value libproc just reported.
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib_len,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 || size < 4 {
        return None;
    }
    let buffer = buffer.get(..size)?;
    let argc = i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?);
    if argc < 0 {
        return None;
    }
    let argc = usize::try_from(argc).ok()?;

    let mut rest = buffer.get(4..)?;
    // Executable path, terminated by NUL.
    let nul = rest.iter().position(|byte| *byte == 0)?;
    rest = rest.get(nul + 1..)?;
    // Skip the NUL padding between the path and argv[0].
    while rest.first() == Some(&0) {
        rest = rest.get(1..)?;
    }

    let mut argv = Vec::new();
    for _ in 0..argc {
        let Some(nul) = rest.iter().position(|byte| *byte == 0) else {
            break;
        };
        argv.push(String::from_utf8_lossy(rest.get(..nul)?).into_owned());
        rest = rest.get(nul + 1..)?;
    }
    Some(argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_child_process_is_visible_with_its_command_and_identity() {
        // The test process is the parent of the child, so this is the same
        // PPID relationship the fallback walks. Both are the same user, which
        // is what libproc requires for command reads.
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let table = table().expect("process table");
        let facts = table.get(&pid).expect("child is in the table");
        assert_eq!(facts.ppid, Some(std::process::id()));
        let start = facts.start_time_ms.expect("a start time");
        let now = chrono::Utc::now().timestamp_millis();
        assert!(
            start <= now && now - start < 60_000,
            "start time must be wall-clock epoch milliseconds, not boot-relative: {start} vs {now}"
        );

        let detail = details(pid);
        let argv = detail.argv.expect("same-user command line is readable");
        assert_eq!(argv.first().map(String::as_str), Some("sleep"));
        assert_eq!(argv.get(1).map(String::as_str), Some("5"));

        let _ = child.kill();
        let _ = child.wait();
    }
}
