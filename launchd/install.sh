#!/bin/sh
# Installs the Mac schedule (launchd). Run from the repo root: sh launchd/install.sh
# Jobs: comms-morning 07:20 (mail -> ledger), today 07:45 (calendar + Telegram brief),
#       today-refresh 12:30 and 17:30, recap Sunday 18:00, comms-poll (always on, powers the Sync button).
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
PREFIX=${PREFIX:-com.$(whoami).warplan}
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS"

job() { # name script args schedule-xml keepalive
  name=$1; script=$2; args=$3; sched=$4; keep=$5
  dir=$(dirname "$REPO/$script")
  plist="$AGENTS/$PREFIX-$name.plist"
  argxml=""; for a in $args; do argxml="$argxml<string>$a</string>"; done
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PREFIX-$name</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/$script</string>$argxml</array>
  <key>WorkingDirectory</key><string>$dir</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.npm-global/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  $sched
  <key>StandardOutPath</key><string>$dir/launchd-$name.out.log</string>
  <key>StandardErrorPath</key><string>$dir/launchd-$name.err.log</string>
  <key>RunAtLoad</key><$keep/>
  $( [ "$keep" = true ] && echo '<key>KeepAlive</key><true/>' )
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/$PREFIX-$name" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  [ "$keep" = true ] && launchctl kickstart "gui/$(id -u)/$PREFIX-$name"
  echo "loaded $PREFIX-$name"
}
at() { echo "<key>StartCalendarInterval</key><array>$*</array>"; }
t() { echo "<dict><key>Hour</key><integer>$1</integer><key>Minute</key><integer>$2</integer>$( [ -n "$3" ] && echo "<key>Weekday</key><integer>$3</integer>" )</dict>"; }

job comms-morning comms/sync.js "--no-telegram" "$(at "$(t 7 20)")" false
job today         today/sync.js "--telegram"    "$(at "$(t 7 45)")" false
job today-refresh today/sync.js ""              "$(at "$(t 12 30)" "$(t 17 30)")" false
job recap         today/recap.js ""             "$(at "$(t 18 0 0)")" false
job comms-poll    comms/poller.js ""            "" true
echo "done. Remove later with: sh launchd/uninstall.sh"
