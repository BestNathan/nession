//! The pinned `nession-interactive-v1` seccomp-BPF profile.
//!
//! It is a conservative *blocklist*: the operations a Nession interactive
//! execution never needs and that are common escalation or host-observation
//! primitives. Everything else is allowed, because the profile must not break
//! shells, TUIs, job control, threads, build tools or language runtimes.
//!
//! The program is emitted as the raw `sock_filter` array that `bwrap
//! --seccomp FD` expects. The launcher shell opens the profile file and passes
//! FD 3 to bwrap, which installs the filter in the sandbox child before it
//! execs the bridge. Descendants inherit it.

use crate::error::{Result, SandboxError};

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JEQ_K: u16 = 0x15;
const BPF_RET_K: u16 = 0x06;

const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;

/// errno 1 (`EPERM`), the kernel's "operation not permitted" number.
const EPERM_ERRNO: u32 = 1;

const SECCOMP_DATA_NR: u32 = 0;
const SECCOMP_DATA_ARCH: u32 = 4;
/// Low 32 bits of `args[1]` (`ioctl`'s request argument).
const SECCOMP_DATA_ARG1_LOW: u32 = 24;

/// The `TIOCSTI` ioctl request, the terminal-injection primitive this profile
/// denies even though `ioctl` itself must stay available for TUIs and resize.
const TIOCSTI_REQUEST: u32 = 0x5412;

#[cfg(target_arch = "x86_64")]
const IOCTL_SYSCALL: u32 = 16;
#[cfg(target_arch = "aarch64")]
const IOCTL_SYSCALL: u32 = 29;

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xC000_003E;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xC000_00B7;

/// One `struct sock_filter`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SockFilter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}

impl SockFilter {
    const fn new(code: u16, jt: u8, jf: u8, k: u32) -> Self {
        Self { code, jt, jf, k }
    }

    fn to_bytes(self) -> [u8; 8] {
        let mut bytes = [0u8; 8];
        let (code, rest) = bytes.split_at_mut(2);
        code.copy_from_slice(&self.code.to_ne_bytes());
        let (jt, rest) = rest.split_at_mut(1);
        jt.copy_from_slice(&self.jt.to_ne_bytes());
        let (jf, rest) = rest.split_at_mut(1);
        jf.copy_from_slice(&self.jf.to_ne_bytes());
        rest.copy_from_slice(&self.k.to_ne_bytes());
        bytes
    }
}

/// Syscall numbers blocked on this architecture.
#[cfg(target_arch = "x86_64")]
const BLOCKED_SYSCALLS: &[(&str, i64)] = &[
    ("mount", 165),
    ("umount2", 166),
    ("pivot_root", 155),
    ("chroot", 161),
    ("ptrace", 101),
    ("process_vm_readv", 310),
    ("process_vm_writev", 311),
    ("init_module", 175),
    ("finit_module", 313),
    ("delete_module", 176),
    ("kexec_load", 246),
    ("kexec_file_load", 320),
    ("reboot", 169),
    ("swapon", 167),
    ("swapoff", 168),
    ("acct", 163),
    ("settimeofday", 164),
    ("clock_settime", 227),
    ("adjtimex", 159),
    ("clock_adjtime", 305),
    ("sethostname", 170),
    ("setdomainname", 171),
    ("iopl", 172),
    ("ioperm", 173),
    ("bpf", 321),
    ("perf_event_open", 298),
    ("userfaultfd", 323),
    ("name_to_handle_at", 303),
    ("open_by_handle_at", 304),
    ("add_key", 248),
    ("request_key", 249),
    ("keyctl", 250),
    ("unshare", 272),
    ("setns", 308),
    ("open_tree", 428),
    ("move_mount", 429),
    ("fsopen", 430),
    ("fsconfig", 431),
    ("fsmount", 432),
    ("fspick", 433),
    ("mount_setattr", 442),
];

/// Syscall numbers blocked on this architecture.
#[cfg(target_arch = "aarch64")]
const BLOCKED_SYSCALLS: &[(&str, i64)] = &[
    ("mount", 40),
    ("umount2", 39),
    ("pivot_root", 41),
    ("chroot", 51),
    ("ptrace", 117),
    ("process_vm_readv", 270),
    ("process_vm_writev", 271),
    ("init_module", 105),
    ("finit_module", 273),
    ("delete_module", 106),
    ("kexec_load", 104),
    ("kexec_file_load", 294),
    ("reboot", 142),
    ("swapon", 224),
    ("swapoff", 225),
    ("acct", 89),
    ("settimeofday", 170),
    ("clock_settime", 112),
    ("adjtimex", 171),
    ("clock_adjtime", 266),
    ("sethostname", 161),
    ("setdomainname", 162),
    ("bpf", 280),
    ("perf_event_open", 241),
    ("userfaultfd", 282),
    ("name_to_handle_at", 264),
    ("open_by_handle_at", 265),
    ("add_key", 217),
    ("request_key", 218),
    ("keyctl", 219),
    ("unshare", 97),
    ("setns", 268),
    ("open_tree", 428),
    ("move_mount", 429),
    ("fsopen", 430),
    ("fsconfig", 431),
    ("fsmount", 432),
    ("fspick", 433),
    ("mount_setattr", 442),
];

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("nession-sandbox has no seccomp profile for this architecture");

/// Build the interactive profile for the build architecture.
pub fn interactive_profile_v1() -> Result<Vec<u8>> {
    let mut program = Vec::with_capacity(BLOCKED_SYSCALLS.len() * 2 + 4);

    // Foreign-architecture processes are killed before any syscall number is
    // compared. A filter whose numbers belong to another ABI is worse than no
    // filter: it can allow what it meant to block.
    program.push(SockFilter::new(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH));
    program.push(SockFilter::new(BPF_JEQ_K, 1, 0, AUDIT_ARCH));
    program.push(SockFilter::new(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS));
    program.push(SockFilter::new(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_NR));

    // `ioctl` stays allowed (TUIs, resize, job control), but its TIOCSTI
    // request is denied by argument. A denied ioctl returns EPERM just like
    // the blocked syscalls below.
    program.push(SockFilter::new(BPF_JEQ_K, 0, 3, IOCTL_SYSCALL));
    program.push(SockFilter::new(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARG1_LOW));
    program.push(SockFilter::new(BPF_JEQ_K, 0, 1, TIOCSTI_REQUEST));
    program.push(SockFilter::new(
        BPF_RET_K,
        0,
        0,
        SECCOMP_RET_ERRNO | EPERM_ERRNO,
    ));

    for (_name, number) in BLOCKED_SYSCALLS {
        let number = u32::try_from(*number).map_err(|_| {
            SandboxError::Prepare("a blocked syscall number is not representable".to_string())
        })?;
        program.push(SockFilter::new(BPF_JEQ_K, 0, 1, number));
        program.push(SockFilter::new(
            BPF_RET_K,
            0,
            0,
            SECCOMP_RET_ERRNO | EPERM_ERRNO,
        ));
    }
    program.push(SockFilter::new(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));

    let mut bytes = Vec::with_capacity(program.len() * 8);
    for instruction in program {
        bytes.extend_from_slice(&instruction.to_bytes());
    }
    Ok(bytes)
}

/// A permissive filter used only by the capability probe: it proves the kernel
/// and bwrap can load *a* filter without changing behaviour.
pub fn probe_profile() -> Vec<u8> {
    let program = [
        SockFilter::new(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH),
        SockFilter::new(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW),
    ];
    let mut bytes = Vec::with_capacity(program.len() * 8);
    for instruction in program {
        bytes.extend_from_slice(&instruction.to_bytes());
    }
    bytes
}

/// The blocked syscall names, for evidence and tests.
pub fn blocked_syscall_names() -> Vec<&'static str> {
    BLOCKED_SYSCALLS.iter().map(|(name, _)| *name).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instructions(bytes: &[u8]) -> Vec<(u16, u8, u8, u32)> {
        bytes
            .chunks_exact(8)
            .map(|chunk| {
                (
                    u16::from_ne_bytes([chunk[0], chunk[1]]),
                    chunk[2],
                    chunk[3],
                    u32::from_ne_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]),
                )
            })
            .collect()
    }

    #[test]
    fn the_profile_starts_with_the_arch_guard_and_ends_with_allow() {
        let bytes = interactive_profile_v1().expect("profile builds");
        assert_eq!(bytes.len() % 8, 0);
        let program = instructions(&bytes);
        assert_eq!(program[0], (BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH));
        assert_eq!(program[1], (BPF_JEQ_K, 1, 0, AUDIT_ARCH));
        assert_eq!(program[2], (BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS));
        assert_eq!(
            *program.last().expect("non-empty"),
            (BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW)
        );
    }

    #[test]
    fn every_blocked_syscall_has_an_errno_pair() {
        let bytes = interactive_profile_v1().expect("profile builds");
        let program = instructions(&bytes);
        for (_name, number) in BLOCKED_SYSCALLS {
            let number = u32::try_from(*number).expect("representable");
            let index = program
                .iter()
                .position(|instruction| *instruction == (BPF_JEQ_K, 0, 1, number))
                .expect("blocked syscall is present");
            assert_eq!(
                program[index + 1],
                (BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM_ERRNO)
            );
        }
    }

    #[test]
    fn clone_and_ioctl_are_not_globally_blocked() {
        // The profile must not break fork/threads, TUIs or job control. These
        // names are absent by construction; the test makes the compatibility
        // promise executable rather than a comment.
        let names = blocked_syscall_names();
        for allowed in ["clone", "clone3", "ioctl", "execve", "wait4", "tty"] {
            assert!(!names.contains(&allowed), "{allowed} must stay allowed");
        }
    }

    #[test]
    fn the_tiocsti_ioctl_request_is_denied_by_argument() {
        let bytes = interactive_profile_v1().expect("profile builds");
        let program = instructions(&bytes);
        let index = program
            .iter()
            .position(|instruction| *instruction == (BPF_JEQ_K, 0, 3, IOCTL_SYSCALL))
            .expect("the ioctl argument guard is present");
        assert_eq!(
            program.get(index + 1),
            Some(&(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARG1_LOW))
        );
        assert_eq!(
            program.get(index + 2),
            Some(&(BPF_JEQ_K, 0, 1, TIOCSTI_REQUEST))
        );
        assert_eq!(
            program.get(index + 3),
            Some(&(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM_ERRNO))
        );
    }
}
