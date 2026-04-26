pub(super) fn remote_status_script() -> &'static str {
    r#"cpu_from_proc_stat() {
  sample() {
    awk '/^cpu / { total=0; for (i=2; i<=NF; i++) total+=$i; idle=$5; if (NF >= 6) idle+=$6; print total, idle; exit }' /proc/stat 2>/dev/null
  }

  set -- $(sample)
  total_a=$1
  idle_a=$2
  if [ -z "$total_a" ] || [ -z "$idle_a" ]; then
    return 1
  fi

  sleep 0.2

  set -- $(sample)
  total_b=$1
  idle_b=$2
  if [ -z "$total_b" ] || [ -z "$idle_b" ]; then
    return 1
  fi

  delta_total=$((total_b - total_a))
  delta_idle=$((idle_b - idle_a))
  if [ "$delta_total" -le 0 ]; then
    return 1
  fi

  usage=$(( (100 * (delta_total - delta_idle) + (delta_total / 2)) / delta_total ))
  printf '%s%%' "$usage"
}

cpu_from_top() {
  LC_ALL=C top -l 2 -n 0 2>/dev/null | awk -F'[:,%]' '
    /CPU usage:/ {
      idle=$(NF-1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", idle)
      if (idle != "") { usage = 100 - idle }
    }
    END {
      if (usage != "") printf "%.0f%%", usage
    }'
}

hostname_val=$(hostname 2>/dev/null || uname -n 2>/dev/null || printf unknown)
user_val=$(id -un 2>/dev/null || whoami 2>/dev/null || printf unknown)
os_val=$(uname -srmo 2>/dev/null || uname -a 2>/dev/null || printf unknown)

uptime_val=$(uptime -p 2>/dev/null || uptime 2>/dev/null | sed 's/^ *//')
if [ -z "$uptime_val" ]; then uptime_val="unavailable"; fi

cpu_val=""
if [ -r /proc/stat ]; then
  cpu_val=$(cpu_from_proc_stat)
fi
if [ -z "$cpu_val" ]; then
  cpu_val=$(cpu_from_top)
fi
if [ -z "$cpu_val" ]; then cpu_val="unavailable"; fi

memory_val=$(free -h 2>/dev/null | awk '/^Mem:/ {print $3 " / " $2}')
if [ -z "$memory_val" ]; then
  memory_val=$(awk '
    /^MemTotal:/ {total=$2}
    /^MemAvailable:/ {avail=$2}
    END {
      if (total > 0 && avail >= 0) {
        used=(total-avail)/1048576;
        total_gb=total/1048576;
        printf "%.1f GiB / %.1f GiB", used, total_gb;
      }
    }' /proc/meminfo 2>/dev/null)
fi
if [ -z "$memory_val" ]; then
  memory_val=$(vm_stat 2>/dev/null | awk 'BEGIN{page=4096} /page size of/ {page=$8} /Pages active/ {gsub("\\.","",$3); active=$3} /Pages wired down/ {gsub("\\.","",$4); wired=$4} /Pages occupied by compressor/ {gsub("\\.","",$5); comp=$5} /Pages free/ {gsub("\\.","",$3); freep=$3} END {used=(active+wired+comp)*page/1073741824; total=(active+wired+comp+freep)*page/1073741824; if (total>0) printf "%.1f GiB / %.1f GiB", used, total}')
fi
if [ -z "$memory_val" ]; then memory_val="unavailable"; fi

disk_val=$(df -hP / 2>/dev/null | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}')
if [ -z "$disk_val" ]; then disk_val="unavailable"; fi

net_val=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$net_val" ]; then
  net_val=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for (i=1; i<=NF; i++) if ($i=="src") {print $(i+1); exit}}')
fi
if [ -z "$net_val" ]; then
  net_val=$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}')
fi
if [ -z "$net_val" ]; then net_val="unavailable"; fi

printf '__OXT__hostname=%s\n' "$hostname_val"
printf '__OXT__user=%s\n' "$user_val"
printf '__OXT__remote_os=%s\n' "$os_val"
printf '__OXT__uptime=%s\n' "$uptime_val"
printf '__OXT__cpu_load=%s\n' "$cpu_val"
printf '__OXT__memory_usage=%s\n' "$memory_val"
printf '__OXT__disk_usage=%s\n' "$disk_val"
printf '__OXT__network=%s\n' "$net_val""#
}

#[cfg(windows)]
pub(super) fn windows_status_script() -> &'static str {
    r#"$hostname_val = $env:COMPUTERNAME
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
$ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254*' } |
  Select-Object -First 1 -ExpandProperty IPAddress
if ([string]::IsNullOrWhiteSpace($ip)) { $ip = 'local' }
Write-Output "__OXT__hostname=$hostname_val"
Write-Output "__OXT__user=$user_val"
Write-Output "__OXT__remote_os=$os_val"
Write-Output "__OXT__uptime=$uptime_val"
Write-Output "__OXT__cpu_load=$cpu_val"
Write-Output "__OXT__memory_usage=$memory_val"
Write-Output "__OXT__disk_usage=$disk_val"
Write-Output "__OXT__network=$ip""#
}
