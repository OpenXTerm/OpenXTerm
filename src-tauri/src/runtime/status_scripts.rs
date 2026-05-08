pub(super) fn remote_status_script() -> &'static str {
    r#"proc_cpu_sample() {
  awk '/^cpu / { total=0; for (i=2; i<=NF; i++) total += $i; idle=$5; if (NF >= 6) idle += $6; print total, idle; exit }' /proc/stat 2>/dev/null
}

proc_cpu_usage() {
  set -- $(proc_cpu_sample)
  total_a=$1
  idle_a=$2
  if [ -z "$total_a" ] || [ -z "$idle_a" ]; then return 1; fi

  sleep 0.2

  set -- $(proc_cpu_sample)
  total_b=$1
  idle_b=$2
  if [ -z "$total_b" ] || [ -z "$idle_b" ]; then return 1; fi

  delta_total=$((total_b - total_a))
  delta_idle=$((idle_b - idle_a))
  if [ "$delta_total" -le 0 ]; then return 1; fi

  usage=$(( (100 * (delta_total - delta_idle) + (delta_total / 2)) / delta_total ))
  printf '%s%%' "$usage"
}

proc_memory_usage() {
  awk '
    /^MemTotal:/ {total=$2}
    /^MemAvailable:/ {avail=$2}
    /^MemFree:/ {free=$2}
    /^Buffers:/ {buffers=$2}
    /^Cached:/ {cached=$2}
    END {
      if (total <= 0) exit 1;
      if (avail <= 0) avail=free+buffers+cached;
      used=(total-avail) * 1024;
      totalb=total * 1024;
      if (used < 0) used=0;
      printf "%.1f GiB / %.1f GiB", used / 1073741824, totalb / 1073741824;
    }' /proc/meminfo 2>/dev/null
}

proc_uptime() {
  awk '{ total=int($1); days=int(total/86400); hours=int((total%86400)/3600); mins=int((total%3600)/60);
    if (days > 0) printf "%dd %dh %dm", days, hours, mins;
    else if (hours > 0) printf "%dh %dm", hours, mins;
    else printf "%dm", mins;
  }' /proc/uptime 2>/dev/null
}

proc_net_sample() {
  awk '
    NR > 2 {
      iface=$1;
      sub(/:$/, "", iface);
      if (iface == "lo") next;
      rx += $2;
      tx += $10;
    }
    END { print rx + 0, tx + 0 }' /proc/net/dev 2>/dev/null
}

disk_usage() {
  (df -lhP / 2>/dev/null || df -hP / 2>/dev/null) | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}'
}

fallback_cpu_usage() {
  LC_ALL=C top -l 2 -n 0 2>/dev/null | awk -F'[:,%]' '
    /CPU usage:/ {
      idle=$(NF-1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", idle)
      if (idle != "") usage = 100 - idle
    }
    END { if (usage != "") printf "%.0f%%", usage }'
}

fallback_memory_usage() {
  vm_stat 2>/dev/null | awk 'BEGIN{page=4096}
    /page size of/ {page=$8}
    /Pages active/ {gsub("\\.","",$3); active=$3}
    /Pages wired down/ {gsub("\\.","",$4); wired=$4}
    /Pages occupied by compressor/ {gsub("\\.","",$5); comp=$5}
    /Pages free/ {gsub("\\.","",$3); freep=$3}
    END {
      used=(active+wired+comp)*page;
      total=(active+wired+comp+freep)*page;
      if (total>0) printf "%.1f GiB / %.1f GiB", used/1073741824, total/1073741824
    }'
}

fallback_network() {
  netstat -ibn 2>/dev/null | awk '
    NR > 1 && $1 !~ /^(lo|lo0|utun|awdl|llw)/ && $7 ~ /^[0-9]+$/ && $10 ~ /^[0-9]+$/ {
      rx += $7;
      tx += $10;
    }
    END { print rx + 0, tx + 0 }'
}

if [ -r /proc/stat ] && [ -r /proc/meminfo ]; then
  hostname_val=$(cat /proc/sys/kernel/hostname 2>/dev/null || hostname 2>/dev/null || uname -n 2>/dev/null || printf unknown)
  user_val=$(id -un 2>/dev/null || whoami 2>/dev/null || printf unknown)
  os_val=$(cat /proc/version 2>/dev/null || uname -srmo 2>/dev/null || uname -a 2>/dev/null || printf unknown)
  uptime_val=$(proc_uptime)
  cpu_val=$(proc_cpu_usage)
  memory_val=$(proc_memory_usage)
  disk_val=$(disk_usage)
  set -- $(proc_net_sample)
  network_rx_bytes=$1
  network_tx_bytes=$2
else
  hostname_val=$(hostname 2>/dev/null || uname -n 2>/dev/null || printf unknown)
  user_val=$(id -un 2>/dev/null || whoami 2>/dev/null || printf unknown)
  os_val=$(uname -srmo 2>/dev/null || uname -a 2>/dev/null || printf unknown)
  uptime_val=$(uptime -p 2>/dev/null || uptime 2>/dev/null | sed 's/^ *//')
  cpu_val=$(fallback_cpu_usage)
  memory_val=$(fallback_memory_usage)
  disk_val=$(disk_usage)
  set -- $(fallback_network)
  network_rx_bytes=$1
  network_tx_bytes=$2
fi

if [ -z "$uptime_val" ]; then uptime_val="unavailable"; fi
if [ -z "$cpu_val" ]; then cpu_val="unavailable"; fi
if [ -z "$memory_val" ]; then memory_val="unavailable"; fi
if [ -z "$disk_val" ]; then disk_val="unavailable"; fi
if [ -z "$network_rx_bytes" ]; then network_rx_bytes=0; fi
if [ -z "$network_tx_bytes" ]; then network_tx_bytes=0; fi

printf '__OXT__hostname=%s\n' "$hostname_val"
printf '__OXT__user=%s\n' "$user_val"
printf '__OXT__remote_os=%s\n' "$os_val"
printf '__OXT__uptime=%s\n' "$uptime_val"
printf '__OXT__cpu_load=%s\n' "$cpu_val"
printf '__OXT__memory_usage=%s\n' "$memory_val"
printf '__OXT__disk_usage=%s\n' "$disk_val"
printf '__OXT__network_rx_bytes=%s\n' "$network_rx_bytes"
printf '__OXT__network_tx_bytes=%s\n' "$network_tx_bytes""#
}

#[cfg(windows)]
pub(super) fn windows_status_script() -> &'static str {
    r#"function Format-Rate([double]$bytes) {
  if ($bytes -ge 1GB) { return ('{0:N1} GiB/s' -f ($bytes / 1GB)) }
  if ($bytes -ge 1MB) { return ('{0:N1} MiB/s' -f ($bytes / 1MB)) }
  if ($bytes -ge 1KB) { return ('{0:N1} KiB/s' -f ($bytes / 1KB)) }
  return ('{0:N0} B/s' -f $bytes)
}

$network_down_bps = 0
$network_up_bps = 0
$networkCounters = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch 'Loopback|Teredo|isatap' }
if ($networkCounters) {
  $network_down_bps = ($networkCounters | Measure-Object -Property BytesReceivedPersec -Sum).Sum
  $network_up_bps = ($networkCounters | Measure-Object -Property BytesSentPersec -Sum).Sum
}
$network_down_val = Format-Rate $network_down_bps
$network_up_val = Format-Rate $network_up_bps

$hostname_val = $env:COMPUTERNAME
if ([string]::IsNullOrWhiteSpace($hostname_val)) { $hostname_val = 'local' }
$user_val = $env:USERNAME
if ([string]::IsNullOrWhiteSpace($user_val)) { $user_val = 'local' }
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) {
  $os_val = "$($os.Caption) $($os.Version)"
  $uptime_span = (Get-Date) - $os.LastBootUpTime
  $uptime_val = "{0}d {1}h {2}m" -f [int]$uptime_span.TotalDays, $uptime_span.Hours, $uptime_span.Minutes
  $used = ($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB
  $total = $os.TotalVisibleMemorySize / 1MB
  $memory_val = "{0:N1} GB / {1:N1} GB" -f $used, $total
} else {
  $os_val = 'Windows'
  $uptime_val = 'unavailable'
  $memory_val = 'unavailable'
}
$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cpu -and $null -ne $cpu.LoadPercentage) { $cpu_val = "$($cpu.LoadPercentage)%" } else { $cpu_val = 'unavailable' }
$drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'" -ErrorAction SilentlyContinue
if ($drive -and $drive.Size -gt 0) {
  $usedDisk = ($drive.Size - $drive.FreeSpace) / 1GB
  $totalDisk = $drive.Size / 1GB
  $pct = (($drive.Size - $drive.FreeSpace) / $drive.Size) * 100
  $disk_val = "{0:N1} GB / {1:N1} GB ({2:N0}%)" -f $usedDisk, $totalDisk, $pct
} else {
  $disk_val = 'unavailable'
}
$network_val = "↓ $network_down_val ↑ $network_up_val"
Write-Output "__OXT__hostname=$hostname_val"
Write-Output "__OXT__user=$user_val"
Write-Output "__OXT__remote_os=$os_val"
Write-Output "__OXT__uptime=$uptime_val"
Write-Output "__OXT__cpu_load=$cpu_val"
Write-Output "__OXT__memory_usage=$memory_val"
Write-Output "__OXT__disk_usage=$disk_val"
Write-Output "__OXT__network=$network_val"
Write-Output "__OXT__network_download=$network_down_val"
Write-Output "__OXT__network_upload=$network_up_val"
Write-Output "__OXT__network_download_bps=$network_down_bps"
Write-Output "__OXT__network_upload_bps=$network_up_bps""#
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    #[test]
    fn remote_status_script_emits_openxterm_keys() {
        let output = std::process::Command::new("sh")
            .args(["-lc", super::remote_status_script()])
            .output()
            .expect("remote status script should launch through sh");

        assert!(
            output.status.success(),
            "remote status script failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let stdout = String::from_utf8_lossy(&output.stdout);
        for key in [
            "__OXT__hostname=",
            "__OXT__user=",
            "__OXT__remote_os=",
            "__OXT__uptime=",
            "__OXT__cpu_load=",
            "__OXT__memory_usage=",
            "__OXT__disk_usage=",
            "__OXT__network_rx_bytes=",
            "__OXT__network_tx_bytes=",
        ] {
            assert!(stdout.contains(key), "missing {key} in {stdout}");
        }
    }
}
