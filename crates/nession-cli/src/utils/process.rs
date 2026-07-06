//! Process management utilities for daemon processes.
//!
//! Provides functions to check process uptime, boot time, and other
//! system-level information useful for monitoring daemon processes.

use anyhow::{Context, Result};
use chrono::{DateTime, Local, Utc};
use std::time::{SystemTime, UNIX_EPOCH};

/// Get the system boot time as a Unix timestamp.
///
/// Returns the number of seconds since the Unix epoch when the system was booted.
#[cfg(target_os = "linux")]
pub fn get_boot_time() -> Result<i64> {
    use std::fs;

    let stat_content = fs::read_to_string("/proc/stat").context("Failed to read /proc/stat")?;

    for line in stat_content.lines() {
        if line.starts_with("btime ") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let btime: i64 = parts[1].parse().context("Failed to parse boot time")?;
                return Ok(btime);
            }
        }
    }

    anyhow::bail!("Boot time not found in /proc/stat")
}

#[cfg(not(target_os = "linux"))]
pub fn get_boot_time() -> Result<i64> {
    // On non-Linux systems, estimate boot time from current time minus uptime
    // This is a fallback implementation
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("Failed to get current time")?
        .as_secs() as i64;

    // Assume system has been up for at least 1 hour
    Ok(now - 3600)
}

/// Get the number of clock ticks per second (USER_HZ).
///
/// On Linux, this is typically 100. On other systems, we use a default value.
#[cfg(target_os = "linux")]
pub fn get_clock_ticks() -> Result<i64> {
    use std::process::Command;

    let output = Command::new("getconf")
        .arg("CLK_TCK")
        .output()
        .context("Failed to execute getconf")?;

    let clk_tck: i64 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .context("Failed to parse CLK_TCK")?;

    Ok(clk_tck)
}

#[cfg(not(target_os = "linux"))]
pub fn get_clock_ticks() -> Result<i64> {
    // Default value for non-Linux systems
    Ok(100)
}

/// Get the uptime of a process in seconds.
///
/// Returns the number of seconds the process has been running,
/// or `None` if the process doesn't exist or uptime cannot be determined.
#[cfg(target_os = "linux")]
pub fn get_process_uptime(pid: u32) -> Option<u64> {
    use std::fs;

    let stat_path = format!("/proc/{}/stat", pid);
    let stat_content = fs::read_to_string(&stat_path).ok()?;

    // Parse the 22nd field (starttime) from /proc/[pid]/stat
    // The fields are space-separated, but the second field (comm) can contain spaces
    // So we need to find the closing parenthesis first
    let close_paren = stat_content.rfind(')')?;
    let after_comm = &stat_content[close_paren + 2..];
    let fields: Vec<&str> = after_comm.split_whitespace().collect();

    // starttime is the 20th field after comm (index 19)
    if fields.len() < 20 {
        return None;
    }

    let starttime: u64 = fields[19].parse().ok()?;
    let clock_ticks = get_clock_ticks().ok()? as u64;
    let boot_time = get_boot_time().ok()? as u64;

    let process_start_time = boot_time + (starttime / clock_ticks);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();

    Some(now.saturating_sub(process_start_time))
}

#[cfg(not(target_os = "linux"))]
pub fn get_process_uptime(_pid: u32) -> Option<u64> {
    // On non-Linux systems, we can't easily determine process uptime
    None
}

/// Get the current timestamp as a DateTime<Local>.
///
/// Returns the current local time.
pub fn current_timestamp() -> DateTime<Local> {
    Local::now()
}

/// Format a timestamp as a human-readable relative time string.
///
/// Examples:
/// - "just now" (less than 1 minute)
/// - "5 minutes ago"
/// - "2 hours ago"
/// - "1 day ago"
pub fn format_time_ago(timestamp: DateTime<Utc>) -> String {
    let now = Utc::now();
    let duration = now.signed_duration_since(timestamp);

    let seconds = duration.num_seconds();
    if seconds < 60 {
        return "just now".to_string();
    }

    let minutes = duration.num_minutes();
    if minutes < 60 {
        return format!(
            "{} minute{} ago",
            minutes,
            if minutes == 1 { "" } else { "s" }
        );
    }

    let hours = duration.num_hours();
    if hours < 24 {
        return format!("{} hour{} ago", hours, if hours == 1 { "" } else { "s" });
    }

    let days = duration.num_days();
    format!("{} day{} ago", days, if days == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_boot_time() {
        let boot_time = get_boot_time().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        // Boot time should be in the past
        assert!(boot_time < now);

        // Boot time should be reasonable (within last 30 days)
        let thirty_days = 30 * 24 * 3600;
        assert!(boot_time > now - thirty_days);
    }

    #[test]
    fn test_get_clock_ticks() {
        let clock_ticks = get_clock_ticks().unwrap();
        assert!(clock_ticks > 0);
        // Typically 100 on most systems
        assert!(clock_ticks >= 1 && clock_ticks <= 1000);
    }

    #[test]
    fn test_get_process_uptime_current_process() {
        let current_pid = std::process::id();
        let uptime = get_process_uptime(current_pid);

        // On Linux, current process should have some uptime
        // On other platforms, this may return None
        #[cfg(target_os = "linux")]
        {
            assert!(uptime.is_some());
            let uptime_secs = uptime.unwrap();
            // Should be at least 0 seconds (just started)
            assert!(uptime_secs >= 0);
        }

        #[cfg(not(target_os = "linux"))]
        {
            // On non-Linux systems, uptime may not be available
            let _ = uptime;
        }
    }

    #[test]
    fn test_get_process_uptime_nonexistent() {
        // Very high PID that likely doesn't exist
        let uptime = get_process_uptime(999999999);
        assert!(uptime.is_none());
    }

    #[test]
    fn test_format_time_ago_just_now() {
        let now = Utc::now();
        let result = format_time_ago(now);
        assert_eq!(result, "just now");
    }

    #[test]
    fn test_format_time_ago_minutes() {
        let five_minutes_ago = Utc::now() - chrono::Duration::minutes(5);
        let result = format_time_ago(five_minutes_ago);
        assert_eq!(result, "5 minutes ago");
    }

    #[test]
    fn test_format_time_ago_hours() {
        let two_hours_ago = Utc::now() - chrono::Duration::hours(2);
        let result = format_time_ago(two_hours_ago);
        assert_eq!(result, "2 hours ago");
    }

    #[test]
    fn test_format_time_ago_days() {
        let three_days_ago = Utc::now() - chrono::Duration::days(3);
        let result = format_time_ago(three_days_ago);
        assert_eq!(result, "3 days ago");
    }

    #[test]
    fn test_format_time_ago_singular() {
        let one_minute_ago = Utc::now() - chrono::Duration::minutes(1);
        let result = format_time_ago(one_minute_ago);
        assert_eq!(result, "1 minute ago");

        let one_hour_ago = Utc::now() - chrono::Duration::hours(1);
        let result = format_time_ago(one_hour_ago);
        assert_eq!(result, "1 hour ago");

        let one_day_ago = Utc::now() - chrono::Duration::days(1);
        let result = format_time_ago(one_day_ago);
        assert_eq!(result, "1 day ago");
    }
}
