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

/// Read one process's own and terminal-foreground process groups.
///
/// `PROC_PIDTBSDINFO` carries both `pbi_pgid` and `e_tpgid`; no process-table
/// scan and no tty open are involved. A process with no controlling terminal
/// reports a non-positive `e_tpgid`, which is returned as `None` rather than
/// mistaken for a prompt.
pub(super) fn process_groups(pid: u32) -> Option<(u32, u32)> {
    let bsd = bsd_info(pid)?;
    // The libc bindings type both fields as `u32`; `0` means the process has
    // no group / no controlling terminal, which is unknown rather than a
    // prompt observation.
    let own = (bsd.pbi_pgid > 0).then_some(bsd.pbi_pgid)?;
    let foreground = (bsd.e_tpgid > 0).then_some(bsd.e_tpgid)?;
    Some((own, foreground))
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
    // SAFETY: `proc_pid_rusage` writes a full `rusage_info_v4` record into the
    // storage named by its `buffer` argument. The pinned libc binding declares
    // that argument as `*mut rusage_info_t` (with `rusage_info_t = *mut c_void`),
    // a pointer-to-pointer shape, but Apple's libproc ABI treats it as the
    // address of the output structure itself — it writes `sizeof(rusage_info_v4)`
    // bytes there. We therefore pass the address of the full-sized, aligned
    // `info` buffer, cast directly to the binding's exact argument type.
    //
    // Passing `&mut pointer` (the address of a local pointer slot, as the
    // pre-#4584 code did) lets libproc write a ~296-byte record into 8 bytes of
    // stack: undefined behavior that zeroed the observed counters and could
    // corrupt the stack / raise SIGBUS. `info` outlives the call, the flavor
    // names the struct the buffer actually is, and a non-zero return is mapped
    // to an honest `io::ErrorKind` rather than a fabricated zero record.
    let result = unsafe {
        libc::proc_pid_rusage(
            pid as libc::c_int,
            libc::RUSAGE_INFO_V4,
            (&mut info as *mut libc::rusage_info_v4).cast(),
        )
    };
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

    /// #4584 SC-01: the output buffer must receive the real record.
    ///
    /// The original defect passed `&mut pointer` (the address of a
    /// pointer-sized stack slot) to `proc_pid_rusage`, so libproc wrote the
    /// full `rusage_info_v4` record into 8 bytes of stack and the `info`
    /// buffer stayed zeroed. The test process has executed code, so its CPU
    /// time, footprint and start abstime must be non-zero; on the original
    /// boundary this fails (or the corrupted stack kills the process, which
    /// the subprocess-boundary test below isolates).
    #[test]
    fn rusage_reports_real_counters_for_the_current_process() {
        let info = rusage(std::process::id()).expect("same-user self rusage is readable");
        assert!(
            info.ri_user_time + info.ri_system_time > 0,
            "CPU time must be a sampled counter, not a zeroed buffer: {info:?}"
        );
        assert!(
            info.ri_resident_size > 0,
            "resident size must be sampled: {info:?}"
        );
        assert!(
            info.ri_phys_footprint > 0,
            "phys footprint must be sampled: {info:?}"
        );
        assert!(
            info.ri_proc_start_abstime > 0,
            "start abstime must be sampled: {info:?}"
        );
    }

    /// #4584 SC-01: repeated real sampling advances monotonically.
    #[test]
    fn rusage_counters_are_monotonic_across_repeated_samples() {
        let pid = std::process::id();
        let first = rusage(pid).expect("first sample");
        // Burn measurable CPU so the second sample must advance.
        let mut acc = 0u64;
        for i in 0..3_000_000u64 {
            acc = acc.wrapping_add(i);
        }
        std::hint::black_box(acc);
        let second = rusage(pid).expect("second sample");
        assert!(
            second.ri_user_time + second.ri_system_time
                >= first.ri_user_time + first.ri_system_time,
            "CPU counters must not go backwards: {first:?} -> {second:?}"
        );
        assert_eq!(
            second.ri_proc_start_abstime, first.ri_proc_start_abstime,
            "process start abstime is stable across samples"
        );
    }

    /// #4584 SC-01: a live same-user child is sampled; a vanished PID is an
    /// honest error, never a crash or a fabricated zero record.
    #[test]
    fn rusage_samples_a_live_child_and_rejects_a_vanished_pid() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let info = rusage(pid).expect("live same-user child rusage");
        assert!(
            info.ri_proc_start_abstime > 0,
            "child start abstime must be sampled"
        );
        let samples = sample(&[pid]);
        let child_sample = samples.get(&pid).expect("child sample");
        assert!(child_sample.alive, "live child must be alive");
        assert!(
            child_sample.io_read_bytes.is_some(),
            "child I/O counters must be present"
        );
        let _ = child.kill();
        let _ = child.wait();

        // A PID above the macOS pid_max ceiling can never be live: the read
        // must fail honestly instead of writing invalid output or fabricating
        // a zero record. The exact `ErrorKind` is platform-mapped (libproc's
        // errno for a gone PID is not stably `NotFound`), so the contract is
        // "an error, never Ok-with-zeros".
        let vanished = rusage(999_999);
        assert!(
            vanished.is_err(),
            "a vanished PID must error, got {vanished:?}"
        );
        let samples = sample(&[999_999]);
        assert!(!samples.get(&999_999).expect("sample entry").alive);
    }

    /// #4584 SC-01: a denied process is reported as denied, not as zeros.
    /// pid 1 (launchd) is unreadable for a non-root caller.
    #[test]
    fn rusage_reports_denied_for_an_unreadable_process() {
        // SAFETY: geteuid has no pointer arguments.
        let euid = unsafe { libc::geteuid() };
        if euid == 0 {
            // Root can read pid 1; the denial boundary is not exercisable.
            return;
        }
        let denied = rusage(1);
        assert!(
            matches!(denied, Err(std::io::ErrorKind::PermissionDenied)),
            "pid 1 must be PermissionDenied for a non-root caller, got {denied:?}"
        );
        // details() consults rusage to distinguish denied from absent; for an
        // unreadable pid it must report denied, not fabricate a zero metric.
        assert!(details(1).io_denied, "pid 1 I/O must be reported denied");
    }

    /// #4584 SC-01: fault-isolated subprocess boundary.
    ///
    /// Re-executes this test binary in a child that runs only the heavy
    /// sampling probe. If the FFI corrupts the stack, the child dies by
    /// signal and the parent observes the actual exit status instead of the
    /// whole harness crashing — the diagnostic the Issue asks for.
    #[test]
    fn rusage_sampling_survives_a_subprocess_boundary() {
        let exe = std::env::current_exe().expect("current test exe");
        let output = std::process::Command::new(exe)
            .arg("--exact")
            .arg("session::process_discovery::macos::tests::rusage_subprocess_probe")
            .env("NESSION_RUSAGE_SUBPROCESS_PROBE", "1")
            .output()
            .expect("spawn rusage probe child");
        assert!(
            output.status.success(),
            "rusage probe child died: {:?}\nstdout:\n{}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Heavy repeated sampling, run only inside the fault-isolated child.
    #[test]
    fn rusage_subprocess_probe() {
        if std::env::var_os("NESSION_RUSAGE_SUBPROCESS_PROBE").is_none() {
            return;
        }
        let pid = std::process::id();
        for _ in 0..200 {
            let info = rusage(pid).expect("probe sample");
            assert!(info.ri_resident_size > 0, "probe sample must be real");
        }
    }

    #[test]
    fn a_child_process_is_visible_with_its_command_and_identity() {
        // The test process is the parent of the child, so this is the same
        // PPID relationship the fallback walks. Both are the same user, which
        // is what libproc requires for command reads.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();

        // `spawn` returns after fork, before the child necessarily finishes
        // exec. libproc cannot report a command line for that window, so a
        // single immediate read is a race under a loaded parallel suite: the
        // full unit run failed here intermittently while the isolated test
        // always passed. Wait for the child to become observable; the bound is
        // far below the child's own lifetime.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let (ppid, start) = loop {
            let table = table().expect("process table");
            if let Some(facts) = table.get(&pid) {
                break (facts.ppid, facts.start_time_ms);
            }
            assert!(
                std::time::Instant::now() < deadline,
                "child is in the process table"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(ppid, Some(std::process::id()));
        let start = start.expect("a start time");
        let now = chrono::Utc::now().timestamp_millis();
        assert!(
            start <= now && now - start < 60_000,
            "start time must be wall-clock epoch milliseconds, not boot-relative: {start} vs {now}"
        );

        let argv = loop {
            if let Some(argv) = details(pid).argv {
                break argv;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "same-user command line is readable"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(argv.first().map(String::as_str), Some("sleep"));
        assert_eq!(argv.get(1).map(String::as_str), Some("30"));

        let _ = child.kill();
        let _ = child.wait();
    }
}
